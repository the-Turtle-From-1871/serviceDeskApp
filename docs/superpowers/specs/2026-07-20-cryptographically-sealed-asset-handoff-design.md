# Cryptographically Sealed Asset Handoff — Design

- **Date:** 2026-07-20
- **Status:** Approved design, pending spec review
- **Author:** ops@turtolabs.com (with Claude)

## 1. Goal

Give each completed hand receipt a tamper-evident, cryptographically verifiable
seal so that "who handed off what, to whom, signed by which recipient, recorded
by which technician, at what instant" cannot later be altered in the database
without detection — and give admins an in-app way to **verify** that seal on
demand. Together this delivers **non-repudiation** for asset handoffs.

A seal is an **Ed25519 digital signature** over a canonical manifest of the
handoff, produced server-side at the moment the receipt (and its recipient
signature) is created, and stored on the `Transfer` record. Verification
recomputes the same canonical manifest from the persisted row and checks the
signature.

## 2. Scope

### In scope
- New nullable columns on `Transfer`: `cryptoSignature`, `sealedAt`.
- New server-only utility `src/lib/crypto.ts`: canonicalize + **sign** + **verify**.
- New server-only domain module `src/modules/transfers/seal.ts`: the single
  shared manifest builder used by both signing and verifying.
- Wiring the seal into `createTransfer` (the one place a receipt + recipient
  signature is persisted).
- **Admin-only in-app verification:** a server action + a "Verify seal" control
  on the receipt detail page returning Valid / Tampered / Unsealed / Can't-verify.
- Environment variable `SIGNING_PRIVATE_KEY` (Ed25519 PKCS#8 PEM).
- Tests (unit + integration + action).
- Documentation: `CHANGELOG.md`, `README.md`, `.env.example`.

### Out of scope (documented follow-ups)
- **Sealing returns or audits.** `ReturnTransaction` and `ItemAudit` also carry
  signatures; sealing them can reuse `crypto.ts` + a sibling manifest builder
  later. Not part of this change.
- **Key rotation / multiple key versions.** Single active key for now; the seal
  format has no key-id. Rotation is a later change.
- **Offline / external verification tooling.** In-app admin verification is
  included; a standalone CLI an outside auditor runs with only the public key is
  a follow-up. (The public key can be derived from the private key or exported
  from it, so nothing here blocks that later.)
- **Exposing the seal on public surfaces.** `cryptoSignature` / `sealedAt` are
  never added to public/list/search selects.

## 3. Background — how a receipt is actually created

There is **no separate "admin completes the transfer" step**. A `Transfer` *is*
the hand receipt. It is created in one shot:

`createReceiptAction` (`src/app/actions/receipts.ts`, gated by `requireUser()`)
→ `createTransfer` (`src/modules/transfers/transfers.service.ts:21`), which runs
a single `prisma.$transaction` that loads + validates items, groups them into
lines server-side, draws the next `receiptNumber` from a sequence, and
`tx.transfer.create({...})` with `receiverSignature` and `createdByUserId`
inline, `status: "OPEN"`.

`status` starts `OPEN`; `CLOSED` happens later on full **return**, not on
signing. So "where the recipient signature is saved" = **receipt creation**, and
that is where the seal is generated.

### Authorization (unchanged for creation)
Receipt creation stays gated by `requireUser()`; per CLAUDE.md rule #1 a standard
`USER` (not only `ADMIN`) may create receipts. The seal is generated for **every**
receipt regardless of role; the acting account is captured as
`createdByUserId: user.id` and bound into the signed manifest. **Verification**,
by contrast, is a privileged audit action and is gated by `requireAdmin()`.

### Relation (unchanged)
`Transfer.createdByUser` / `createdByUserId` already links the acting technician
and stays **nullable**, matching the codebase pattern (`ItemEdit`,
`ReturnTransaction`, `Contact`) where history survives account deletion. We do
**not** make it non-null; non-repudiation comes from the signed `actingUserId`
inside the manifest, not the FK's nullability.

## 4. Design

### 4.1 Schema changes (`prisma/schema.prisma`, model `Transfer`)

```prisma
// Ed25519 signature (base64) over the canonical handoff manifest, produced at
// creation. Null when unsealed: pre-existing rows, or best-effort failures when
// SIGNING_PRIVATE_KEY is absent/invalid. Verified via verifyReceiptSealAction.
cryptoSignature String?

// The exact server timestamp fed into the signed manifest. Persisted (rather
// than reusing createdAt, which the DB default stamps a hair later) so the
// signed bytes can be reproduced for verification. Prisma DateTime => timestamp(3),
// millisecond precision, which round-trips through toISOString() exactly.
sealedAt DateTime?
```

Both nullable → the migration is a plain additive `ALTER TABLE ... ADD COLUMN`,
no backfill, safe on the 1,200+ row `Transfer` table. No index (neither column
is filtered or sorted on).

### 4.2 `src/lib/crypto.ts` (server-only, generic — knows nothing about transfers)

```ts
import "server-only";
import { sign, verify, createPublicKey } from "node:crypto";

/** Deterministic JSON: recursively sort object keys so the signed byte string is
 *  reproducible. Arrays keep their order — CALLERS must pre-sort arrays whose
 *  element order isn't already deterministic (see seal.ts item sort). */
export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function privateKeyPem(): string | null {
  return process.env.SIGNING_PRIVATE_KEY?.replace(/\\n/g, "\n") ?? null;
}

/** Ed25519 seal (base64) over the canonical manifest. Best-effort: returns null
 *  + logs if the key is absent or signing throws, so sealing never blocks a
 *  handoff. Ed25519 hashes internally — algorithm arg is null, no separate SHA-256. */
export function generateCryptographicSeal(manifestData: object): string | null {
  const pem = privateKeyPem();
  if (!pem) { console.error("[crypto] SIGNING_PRIVATE_KEY unset; storing receipt unsealed."); return null; }
  try {
    return sign(null, Buffer.from(canonicalize(manifestData), "utf8"), pem).toString("base64");
  } catch (err) { console.error("[crypto] seal generation failed; storing unsealed:", err); return null; }
}

/** Verify a base64 Ed25519 seal against the canonical manifest. Public key is
 *  DERIVED from SIGNING_PRIVATE_KEY (createPublicKey) — no separate env var.
 *  Throws CryptoKeyUnavailableError when no key is configured (caller maps that
 *  to "can't verify"); returns false for a genuine signature mismatch (tamper). */
export class CryptoKeyUnavailableError extends Error {}
export function verifyCryptographicSeal(manifestData: object, signatureBase64: string): boolean {
  const pem = privateKeyPem();
  if (!pem) throw new CryptoKeyUnavailableError("SIGNING_PRIVATE_KEY unset");
  const publicKey = createPublicKey(pem); // Ed25519 public half of the pair
  return verify(null, Buffer.from(canonicalize(manifestData), "utf8"), publicKey, Buffer.from(signatureBase64, "base64"));
}
```

Notes: `import "server-only"` satisfies CLAUDE.md rule #4; vitest aliases
`server-only` to an empty module so tests import it fine. The `.replace` handles
single-line `.env` PEMs and is a no-op on Vercel's real newlines. Distinguishing
a thrown `CryptoKeyUnavailableError` (misconfig) from a `false` return (tamper)
is what lets the UI say "can't verify" vs "TAMPERED".

### 4.3 `src/modules/transfers/seal.ts` (server-only) — the ONE manifest builder

This is the load-bearing anti-drift piece: signing and verifying MUST build
byte-identical manifests, so both go through here.

```ts
import "server-only";

export type ManifestInput = {
  receiptNumber: string;
  actingUserId: string | null;
  sealedAt: Date;
  receiver: { isDcsim: boolean; name: string; rank: string | null; unit: string | null; contact: string | null; email: string | null };
  receiverSignature: string;
  items: { serialNumber: string; make: string; model: string }[];
};

/** Normalized, order-stable manifest. Items are sorted by serialNumber (unique
 *  per receipt => total order) so the array is deterministic regardless of DB
 *  row order. canonicalize() then sorts object keys. */
export function buildHandoffManifest(input: ManifestInput) {
  return {
    receiptNumber: input.receiptNumber,
    actingUserId: input.actingUserId,
    sealedAt: input.sealedAt.toISOString(),
    receiver: { ...input.receiver },
    receiverSignature: input.receiverSignature,
    items: [...input.items].sort((a, b) => a.serialNumber.localeCompare(b.serialNumber)),
  };
}

/** Reconstruct the manifest from a persisted receipt (Transfer + lines + items).
 *  Field mapping MUST mirror what createTransfer passed in. Returns null if the
 *  row was never sealed (no sealedAt). */
export function manifestFromTransfer(t: ReceiptWithLines) {
  if (!t.sealedAt) return null;
  return buildHandoffManifest({
    receiptNumber: t.receiptNumber,
    actingUserId: t.createdByUserId ?? null,
    sealedAt: t.sealedAt,
    receiver: { isDcsim: t.receiverIsDcsim, name: t.receiverName, rank: t.receiverRank ?? null, unit: t.receiverUnit ?? null, contact: t.receiverContact ?? null, email: t.receiverEmail ?? null },
    receiverSignature: t.receiverSignature,
    items: t.lines.flatMap((ln) => ln.items.map((it) => ({ serialNumber: it.serialNumber, make: ln.make, model: ln.model }))),
  });
}
```

### 4.4 Wiring into `createTransfer` (sign)

Inside the existing `$transaction`, right before `tx.transfer.create`, assemble
the manifest input from the same in-memory data already used to build the rows:

```ts
const sealedAt = new Date();
const manifest = buildHandoffManifest({
  receiptNumber, actingUserId: createdByUserId ?? null, sealedAt,
  receiver: { isDcsim: receiver.isDcsim, name: receiver.name, rank: receiver.rank ?? null, unit: receiver.unit ?? null, contact: receiver.contact ?? null, email: receiver.email ?? null },
  receiverSignature,
  items: grouped.flatMap((g) => g.itemIds.map((id, i) => ({ serialNumber: g.serials[i], make: g.make, model: g.model }))),
});
const cryptoSignature = generateCryptographicSeal(manifest);
```

Then add `sealedAt` and `cryptoSignature` to the `data` of
`tx.transfer.create({...})`. No new query, no loop, no N+1 — pure in-memory work
inside the txn that already runs. `sealedAt` is always stamped; `cryptoSignature`
may be null under best-effort. `createReceiptAction` is unchanged.

### 4.5 Verification action (`src/app/actions/receipts.ts` or a sibling)

```ts
"use server";
// verifyReceiptSealAction(receiptNumber): admin-only integrity check.
export async function verifyReceiptSealAction(receiptNumber: string):
  Promise<{ status: "VALID" | "TAMPERED" | "UNSEALED" | "CANNOT_VERIFY" | "NOT_FOUND"; sealedAt?: string }> {
  await requireAdmin();                                   // privileged; re-reads role/isActive
  const t = await getTransferByReceiptNumber(receiptNumber);
  // Existence is NOT guaranteed at click time even though the admin opened this
  // from a live receipt page: the 90-day purge worker (or another admin) can
  // hard-delete a CLOSED receipt while the tab sits open. Report that distinctly
  // rather than mislabeling a deleted receipt as merely "unsealed".
  if (!t) return { status: "NOT_FOUND" };
  if (!t.cryptoSignature || !t.sealedAt) return { status: "UNSEALED" };
  const manifest = manifestFromTransfer(t);               // non-null here (sealedAt present)
  try {
    const ok = verifyCryptographicSeal(manifest!, t.cryptoSignature);
    return { status: ok ? "VALID" : "TAMPERED", sealedAt: t.sealedAt.toISOString() };
  } catch (e) {
    if (e instanceof CryptoKeyUnavailableError) return { status: "CANNOT_VERIFY" };
    console.error("[verifyReceiptSealAction] verify failed:", e);
    return { status: "CANNOT_VERIFY" };
  }
}
```

Status meanings surfaced to the admin:
- **VALID** — seal matches; the sealed fields are intact.
- **TAMPERED** — signature present but does not match the current row; a sealed
  field was altered in the DB. (Loud, red.)
- **UNSEALED** — no seal on this receipt (predates the feature, or was created
  while the key was unset). Neutral, not an error.
- **CANNOT_VERIFY** — server has no `SIGNING_PRIVATE_KEY` configured, so no key to
  derive a verifier from. Ops/config issue, not a receipt problem.
- **NOT_FOUND** — the receipt no longer exists (e.g. purged, or deleted from
  another session while this tab was open). Distinct from UNSEALED so a deleted
  receipt is never mislabeled as "unsealed". The UI should prompt a refresh.

### 4.6 Verification UI (receipt detail page)

The receipt page (`src/app/receipts/[receiptNumber]/page.tsx`) already computes
`isAdmin` from the session and renders admin-only controls
(`ReceiptDueAtControls`, "Process return") — the seal control follows that exact
pattern:

- New client component `ReceiptSealVerify` (sibling of `ReceiptDueAtControls`):
  a **"Verify seal"** button that calls `verifyReceiptSealAction(receiptNumber)`
  and renders the returned status as a badge (VALID = green, TAMPERED = red,
  UNSEALED = subtle/grey, CANNOT_VERIFY = warning, NOT_FOUND = warning + "refresh
  the page"), with the `sealedAt` timestamp on success.
- Rendered only when `isAdmin` (UI convenience; the action re-checks
  `requireAdmin()` as the authoritative gate — the page itself is public and
  logged-out/USER visitors simply never see the control).
- **Placement:** receipt detail page only in this change. The same
  action + component can later be dropped onto the admin item view; that reuse is
  a follow-up, not part of this scope.

### 4.7 Failure behavior (confirmed decisions)

- **Signing:** missing/invalid key or error → receipt still saves,
  `cryptoSignature` null, logged server-side. Best-effort; never blocks a handoff.
- **Verifying:** missing key → `CANNOT_VERIFY` (not an exception to the user);
  signature mismatch → `TAMPERED`. Verification never mutates anything.

### 4.8 Key management

- `SIGNING_PRIVATE_KEY` — Ed25519 **private** key, PKCS#8 PEM. Generate with:
  ```
  node -e "const {generateKeyPairSync}=require('crypto');const {privateKey,publicKey}=generateKeyPairSync('ed25519');console.log(privateKey.export({type:'pkcs8',format:'pem'}));console.log(publicKey.export({type:'spki',format:'pem'}))"
  ```
- **Dev:** one-line, `\n`-escaped, double-quoted value in `.env.local` (gitignored).
- **Prod (Vercel):** paste the multi-line PEM directly (BEGIN/END lines included).
  Use a **separate** key from dev; never commit either.
- **No `SIGNING_PUBLIC_KEY` env var** — in-app verification derives the public key
  from the private key at runtime (`createPublicKey`), so the pair can never
  drift. The exported public key is retained by ops only for future offline audit.

## 5. Testing

Test DB is shared and serial (`fileParallelism: false`); env loads from
`.env.test`. Tests manage `process.env.SIGNING_PRIVATE_KEY` themselves (the util
reads it at call time, so per-test set/unset works) and restore it afterward so
key presence never leaks between tests.

### Unit — `src/lib/crypto.test.ts`
- Ephemeral Ed25519 keypair in-test → `generateCryptographicSeal` output verifies
  via `verifyCryptographicSeal` (round-trip true).
- Canonicalization order-independence: same entries, different key order → same seal.
- Tamper: mutate any manifest field → `verifyCryptographicSeal` returns false.
- Missing key: `generateCryptographicSeal` → null; `verifyCryptographicSeal` →
  throws `CryptoKeyUnavailableError`.

### Unit — `src/modules/transfers/seal.test.ts`
- `buildHandoffManifest` sorts items by serialNumber → same seal regardless of
  input item order.
- `manifestFromTransfer` on a sealed row reproduces the exact manifest
  `buildHandoffManifest` produced at creation (feed one into the other, assert seal equality).

### Integration — extend `src/modules/transfers/transfers.service.test.ts`
- With an ephemeral key set: `createTransfer(...)` stores non-null
  `cryptoSignature` + `sealedAt`; `manifestFromTransfer(persistedRow)` verifies
  **true**.
- Tamper end-to-end: after creation, `prisma.transfer.update` a sealed field
  (e.g. `receiverName`) → verify returns **false** (→ TAMPERED).
- No key at creation: `createTransfer(...)` still succeeds, `cryptoSignature`
  null, `sealedAt` set.

### Action — `src/app/actions/receipts.test.ts` (or sibling)
- `verifyReceiptSealAction` rejects non-admin / logged-out (`requireAdmin`).
- Returns VALID for an intact sealed receipt, TAMPERED after a DB mutation,
  UNSEALED for a null-signature row, CANNOT_VERIFY with the key unset, and
  NOT_FOUND for an unknown/deleted receiptNumber.

## 6. Documentation (same commit as code)

- **`CHANGELOG.md`** — under `## 2026-07-20`: an **Added** entry for the seal +
  admin verification workflow, and a **Notes** subsection for the
  `SIGNING_PRIVATE_KEY` env var (Ed25519 PKCS#8 PEM, generation command,
  best-effort/optional, prod-on-Vercel guidance, public key derived not stored).
- **`README.md`** — add `SIGNING_PRIVATE_KEY` to the Environment-variables table;
  note the seal is best-effort and verification is admin-only and derives the
  public key from the private key (no separate var).
- **`.env.example`** — commented, empty `SIGNING_PRIVATE_KEY=` with a one-line
  generation hint (no real key). No `SIGNING_PUBLIC_KEY` entry.

## 7. Migration / ops notes

- Two nullable additive columns → author via
  `prisma migrate diff --from-config-datasource --to-schema ... --script` then
  `prisma migrate deploy` (repo constraint: `prisma migrate dev` can't run in this
  shell). No backfill; safe online `ADD COLUMN`.
- Prod apply follows the existing manual path (Supabase MCP + a `_prisma_migrations`
  row with the CRLF sha256), same as prior migrations.
- **Ops action:** set `SIGNING_PRIVATE_KEY` in Vercel. If unset, receipts are
  created **unsealed** and verification reports **CANNOT_VERIFY** (both by design)
  until it is provided.

## 8. Security considerations

- Private key only ever server-side (`server-only` utils, env var); never bundled,
  never logged (errors log a message, not the key).
- Seal covers recipient PII, the signature image, acting user, receipt number,
  and timestamp — the fields that matter for repudiation disputes.
- Verification is `requireAdmin()`-gated and read-only; it exposes only a status
  (+ sealedAt), never re-derives PII to the client. `cryptoSignature` / `sealedAt`
  stay out of every public/list/search select.
- Does not change the accepted public-by-design exposure of receipts/items; the
  seal is additive integrity metadata.
- Best-effort sealing means absence of a seal is **not** proof of tampering (may
  predate the key). UNSEALED and TAMPERED are distinct statuses precisely so an
  admin never confuses "never sealed" with "sealed then altered".

## 9. Resolved decisions

- Ed25519 (not RSA-SHA256): modern, small keys, no padding pitfalls.
- Best-effort sealing (not hard-fail).
- `requireUser()` retained for creation; `requireAdmin()` for verification.
- `createdByUser` stays nullable (not "strict").
- `sealedAt` column added for verifiability (accepted extension beyond the single
  requested `cryptoSignature` field).
- **Verification in scope:** admin-only, in-app, on the receipt detail page;
  public key derived from the private key at runtime (no `SIGNING_PUBLIC_KEY`).
- Single shared manifest builder (`seal.ts`) for sign + verify to prevent drift.
