# Cryptographically Sealed Asset Handoff — Design

- **Date:** 2026-07-20
- **Status:** Approved design, pending spec review
- **Author:** ops@turtolabs.com (with Claude)

## 1. Goal

Give each completed hand receipt a tamper-evident, cryptographically verifiable
seal so that "who handed off what, to whom, signed by which recipient, recorded
by which technician, at what instant" cannot later be altered in the database
without detection. This delivers **non-repudiation** for asset handoffs.

A seal is an **Ed25519 digital signature** over a canonical manifest of the
handoff, produced server-side at the moment the receipt (and its recipient
signature) is created, and stored on the `Transfer` record.

## 2. Scope

### In scope
- New nullable columns on `Transfer`: `cryptoSignature`, `sealedAt`.
- New server-only utility `src/lib/crypto.ts` that produces the seal.
- Wiring the seal into `createTransfer` (the one place a receipt + recipient
  signature is persisted).
- Environment variable `SIGNING_PRIVATE_KEY` (Ed25519 PKCS#8 PEM).
- Tests (unit + integration).
- Documentation: `CHANGELOG.md`, `README.md`, `.env.example`.

### Out of scope (documented follow-ups)
- **Verification endpoint / UI.** The seal is generated and stored now; a
  route/CLI that re-derives the manifest and calls `crypto.verify(...)` against
  a `SIGNING_PUBLIC_KEY` is a separate change. The public key is noted in the
  README so ops can retain it, but the app does not read it yet.
- **Sealing returns or audits.** `ReturnTransaction` and `ItemAudit` also carry
  signatures; sealing them can reuse `crypto.ts` later. Not part of this change.
- **Key rotation / multiple key versions.** Single active key for now.

## 3. Background — how a receipt is actually created

There is **no separate "admin completes the transfer" step**. A `Transfer` *is*
the hand receipt. It is created in one shot:

`createReceiptAction` (`src/app/actions/receipts.ts`, gated by `requireUser()`)
→ `createTransfer` (`src/modules/transfers/transfers.service.ts:21`), which runs
a single `prisma.$transaction` that:

1. loads + validates the items,
2. groups them into lines server-side,
3. draws the next `receiptNumber` from a sequence,
4. `tx.transfer.create({...})` with `receiverSignature` and
   `createdByUserId` inline, `status: "OPEN"`.

`status` starts `OPEN`; `CLOSED` happens later on full **return**, not on
signing. So "where the recipient signature is saved" = **receipt creation**, and
that is where the seal is generated.

### Authorization (unchanged)
Receipt creation is gated by `requireUser()`, and per CLAUDE.md rule #1 a
standard `USER` (not only `ADMIN`) may create receipts. The seal is generated
for **every** receipt regardless of role; the acting account is already captured
as `createdByUserId: user.id` and is bound into the signed manifest. We do **not**
switch this to `requireAdmin()` — that would break the documented USER
capability.

### Relation (unchanged)
`Transfer.createdByUser` / `createdByUserId` already links the acting technician
and stays **nullable**, matching the codebase pattern (`ItemEdit`,
`ReturnTransaction`, `Contact`) where history survives the acting account being
deleted. We do **not** make it "strict"/non-null; non-repudiation comes from the
signed `actingUserId` inside the manifest, not the FK's nullability.

## 4. Design

### 4.1 Schema changes (`prisma/schema.prisma`, model `Transfer`)

```prisma
// Ed25519 signature (base64) over the canonical handoff manifest, produced at
// creation. Null when unsealed: pre-existing rows, or best-effort failures when
// SIGNING_PRIVATE_KEY is absent/invalid. Verified later against SIGNING_PUBLIC_KEY.
cryptoSignature String?

// The exact server timestamp fed into the signed manifest. Persisted (rather
// than reusing createdAt, which the DB default stamps a hair later) so the
// signed bytes can be reproduced for verification.
sealedAt DateTime?
```

Both nullable → the migration is a plain additive `ALTER TABLE ... ADD COLUMN`,
no backfill, safe on the 1,200+ row `Transfer` table. No index needed (neither
column is filtered or sorted on).

### 4.2 `src/lib/crypto.ts` (server-only)

```ts
import "server-only";
import { sign } from "node:crypto";

/**
 * Deterministic JSON: recursively sort object keys so the signed byte string is
 * reproducible for verification. Arrays keep their order (item order is
 * server-derived and stable). Primitives use JSON.stringify for correct escaping.
 */
function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Produce an Ed25519 seal (base64) over the canonical manifest, signed with
 * SIGNING_PRIVATE_KEY (Ed25519 PKCS#8 PEM). Best-effort: returns null and logs
 * server-side if the key is absent or signing throws, so sealing never blocks a
 * handoff. Ed25519 hashes internally — there is no separate SHA-256 step and the
 * algorithm arg to sign() is null.
 */
export function generateCryptographicSeal(manifestData: object): string | null {
  const pem = process.env.SIGNING_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!pem) {
    console.error("[crypto] SIGNING_PRIVATE_KEY is not set; receipt will be stored unsealed.");
    return null;
  }
  try {
    const canonical = canonicalize(manifestData);
    return sign(null, Buffer.from(canonical, "utf8"), pem).toString("base64");
  } catch (err) {
    console.error("[crypto] failed to generate seal; storing receipt unsealed:", err);
    return null;
  }
}
```

Notes:
- `import "server-only"` satisfies CLAUDE.md rule #4 (blocks client bundling).
  The vitest config aliases `server-only` to an empty module, so tests import it
  fine.
- `.replace(/\\n/g, "\n")` un-escapes single-line `.env` PEMs; a no-op on
  already-multiline values (Vercel).
- Returns `string | null` — the best-effort contract end to end. The caller
  stores whatever it returns.

### 4.3 The manifest (what gets signed)

Built inside `createTransfer` once all fields are known. Every field is
server-derived — nothing trusts client-posted identity/signatures (signer name +
blob are already resolved server-side upstream in `createReceiptAction`;
`actingUserId` comes from the session):

```ts
const manifest = {
  receiptNumber,                     // server sequence, e.g. "HR-000123"
  actingUserId: createdByUserId ?? null,
  sealedAt: sealedAt.toISOString(),  // server timestamp, also persisted
  receiver: {
    isDcsim: receiver.isDcsim,
    name: receiver.name,
    rank: receiver.rank ?? null,
    unit: receiver.unit ?? null,
    contact: receiver.contact ?? null,
    email: receiver.email ?? null,
  },
  receiverSignature,                 // the recipient's PNG data URL
  items: grouped.flatMap((g) =>
    g.itemIds.map((id, i) => ({ serialNumber: g.serials[i], make: g.make, model: g.model })),
  ),
};
```

### 4.4 Wiring into `createTransfer`

Inside the existing `$transaction`, right before `tx.transfer.create`:

```ts
const sealedAt = new Date();
const cryptoSignature = generateCryptographicSeal(manifest);
```

Then add both to the `data` of `tx.transfer.create({ data: { ... } })`:

```ts
sealedAt,
cryptoSignature,           // string | null
```

No new query, no loop, no N+1 — it is pure in-memory work inside the txn that
already runs. `sealedAt` is always stamped; `cryptoSignature` may be null under
best-effort. `createReceiptAction` is unchanged.

### 4.5 Failure behavior (confirmed decisions)

- **Missing/invalid key or signing error →** receipt still saves,
  `cryptoSignature` stays null, error logged server-side. Sealing never blocks a
  technician handing off equipment. (Client sees no crypto-specific error;
  matches CLAUDE.md rule #5.)
- **Auth →** `requireUser()`, unchanged; seal generated for USER and ADMIN alike.

### 4.6 Key management

- `SIGNING_PRIVATE_KEY` — Ed25519 **private** key, PKCS#8 PEM. Generate with:
  ```
  node -e "const {generateKeyPairSync}=require('crypto');const {privateKey,publicKey}=generateKeyPairSync('ed25519');console.log(privateKey.export({type:'pkcs8',format:'pem'}));console.log(publicKey.export({type:'spki',format:'pem'}))"
  ```
- **Dev:** one-line, `\n`-escaped, double-quoted value in `.env.local` (gitignored).
- **Prod (Vercel):** paste the multi-line PEM directly into the env var. Use a
  **separate** key from dev; never commit either.
- The matching **public** key is retained by ops for future verification
  (`SIGNING_PUBLIC_KEY`); the app does not read it in this change.

## 5. Verification (future, out of scope)

Given a stored `Transfer` row, rebuild the identical manifest from persisted
fields (`receiptNumber`, `receiver*`, `receiverSignature`, `createdByUserId`,
`sealedAt`, and the item serials/make/model from `TransferItem`), canonicalize
it the same way, and run
`crypto.verify(null, bytes, SIGNING_PUBLIC_KEY, Buffer.from(cryptoSignature, "base64"))`.
Any DB alteration to the sealed fields flips the result to false — that is the
tamper-evidence. This is exactly why `sealedAt` is persisted.

## 6. Testing

Test DB is shared and serial (`fileParallelism: false`); env loads from
`.env.test`. Tests must **not** depend on a key being present in `.env.test` —
they manage `process.env.SIGNING_PRIVATE_KEY` themselves. Because the util reads
the env var at call time (not module load), set/unset per test works.

### Unit — `src/lib/crypto.test.ts`
- Generate an ephemeral Ed25519 keypair in-test; set `SIGNING_PRIVATE_KEY`.
  Assert `generateCryptographicSeal({...})` returns a base64 string that
  `crypto.verify(null, canonicalBytes, publicKey, sig)` accepts.
- Canonicalization is order-independent: two objects with the same entries in
  different key orders produce the **same** seal.
- Tamper: changing any manifest field produces a signature that fails verify.
- Missing key → returns `null` (no throw). Restore env after each test.

### Integration — extend `src/modules/transfers/transfers.service.test.ts`
- With an ephemeral `SIGNING_PRIVATE_KEY` set: `createTransfer(...)` stores a
  non-null `cryptoSignature` and a `sealedAt`; re-deriving the manifest from the
  persisted row verifies true against the ephemeral public key.
- With `SIGNING_PRIVATE_KEY` unset: `createTransfer(...)` still succeeds, the
  receipt exists, `cryptoSignature` is null, `sealedAt` is set.
- Save/restore `process.env.SIGNING_PRIVATE_KEY` around these cases so key
  presence never leaks between tests.

## 7. Documentation (same commit as code)

- **`CHANGELOG.md`** — under `## 2026-07-20`, an **Added** entry describing the
  cryptographic non-repudiation seal on hand receipts, plus a **Notes**
  subsection introducing the `SIGNING_PRIVATE_KEY` env var (Ed25519 PKCS#8 PEM,
  generation command, optional/best-effort, prod-on-Vercel guidance).
- **`README.md`** — add `SIGNING_PRIVATE_KEY` to the Environment-variables table
  with a one-line purpose; note the seal is best-effort and the public key is
  retained for future verification.
- **`.env.example`** — add a commented, empty `SIGNING_PRIVATE_KEY=` entry with a
  one-line generation hint (no real key).

## 8. Migration / ops notes

- Two nullable additive columns → author via
  `prisma migrate diff --from-config-datasource --to-schema ... --script` then
  `prisma migrate deploy` (per repo constraint: `prisma migrate dev` cannot run
  in this shell). No backfill; safe online `ADD COLUMN`.
- Prod apply follows the existing manual-apply path (Supabase MCP + a
  `_prisma_migrations` row with the CRLF sha256), same as prior migrations.
- **Ops action:** set `SIGNING_PRIVATE_KEY` in Vercel before/at deploy. If unset,
  receipts are created **unsealed** (by design) until it is provided.

## 9. Security considerations

- Private key only ever server-side (`server-only` util, env var); never bundled,
  never logged (errors log a message, not the key).
- Seal covers recipient PII, the signature image, acting user, receipt number,
  and timestamp — the fields that matter for repudiation disputes.
- Does not change the accepted public-by-design exposure of receipts/items
  (CLAUDE.md); the seal is additional metadata, and `cryptoSignature` /
  `sealedAt` should **not** be added to any public select unless a verification
  feature deliberately exposes them.
- Best-effort sealing means absence of a seal is **not** proof of tampering (it
  may just predate the key); verification treats null as "unsealed", not "forged".

## 10. Resolved decisions

- Ed25519 (not RSA-SHA256): modern, small keys, no padding pitfalls.
- Best-effort sealing (not hard-fail).
- `requireUser()` retained (not `requireAdmin()`).
- `createdByUser` stays nullable (not "strict").
- Add `sealedAt` for verifiability (accepted extension beyond the single
  requested `cryptoSignature` field).
