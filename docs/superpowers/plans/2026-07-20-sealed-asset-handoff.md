# Cryptographically Sealed Asset Handoff — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seal every hand receipt at creation with an Ed25519 signature over a canonical handoff manifest, and give admins an in-app way to verify that seal, so receipts are tamper-evident (non-repudiation).

**Architecture:** A generic `crypto.ts` (canonicalize + sign + verify) and a domain `seal.ts` (the single shared manifest builder used by BOTH signing and verifying, so they can never drift). `createTransfer` builds the manifest and stores a best-effort signature + `sealedAt` on the `Transfer` row. An admin-only server action re-derives the manifest from the persisted row and verifies it; a "Verify seal" button on the receipt page surfaces the result.

**Tech Stack:** Next.js 16 (App Router, Server Components/Actions, React 19), Prisma 7 over Postgres, Node `crypto` (Ed25519), Vitest, TypeScript 5.

## Global Constraints

- **Auth:** every Server Action starts with `requireUser()` or `requireAdmin()` from `@/lib/authz` — never bare `auth()`. Receipt **creation** stays `requireUser()` (USERs may create receipts); **verification** is `requireAdmin()`.
- **Server-only:** `src/lib/crypto.ts` and `src/modules/transfers/seal.ts` MUST start with `import "server-only";`.
- **Secrets:** never log the key or its contents — log a message only. Read the key from `process.env.SIGNING_PRIVATE_KEY`; never hardcode.
- **Best-effort sealing:** a missing/invalid key or signing error must NOT fail receipt creation — store `cryptoSignature = null` and log.
- **Signature scheme:** Ed25519. `sign(null, bytes, key)` / `verify(null, bytes, pubkey, sig)` — no `createSign`, no separate SHA-256 step. Public key for verification is DERIVED from the private key (`createPublicKey`) — there is NO `SIGNING_PUBLIC_KEY` env var.
- **Data fetching:** no queries in loops; `select`/`include` only what's needed; never add `cryptoSignature`/`sealedAt` to any public/list/search select.
- **Docs same commit:** the doc task ships in the same commit as the code it documents (Task 7 is folded into the feature, not a follow-up PR).
- **Relation unchanged:** `Transfer.createdByUser`/`createdByUserId` stays nullable — do not make it non-null.
- **Migrations:** `prisma migrate dev` cannot run in this shell — hand-author `migration.sql` and apply with `prisma migrate deploy` (matches existing hand-named migrations).

**Reference spec:** `docs/superpowers/specs/2026-07-20-cryptographically-sealed-asset-handoff-design.md`

**Prereq:** local Postgres up (`docker compose up -d`) and `.env.local` has a valid `SIGNING_PRIVATE_KEY` (already configured in dev).

---

### Task 1: Schema columns + migration

**Files:**
- Modify: `prisma/schema.prisma` (model `Transfer`, after the `receiverSignature` field ~line 141)
- Create: `prisma/migrations/20260720210000_transfer_crypto_seal/migration.sql`

**Interfaces:**
- Produces: `Transfer.cryptoSignature: string | null` and `Transfer.sealedAt: Date | null` on the Prisma client, used by Tasks 3–5.

- [ ] **Step 1: Add the two fields to `prisma/schema.prisma`**

In `model Transfer`, immediately after the `receiverSignature String` line, add:

```prisma
  // Ed25519 signature (base64) over the canonical handoff manifest, produced at
  // creation. Null when unsealed: pre-existing rows, or best-effort failures when
  // SIGNING_PRIVATE_KEY is absent/invalid. Verified via verifyReceiptSealAction.
  cryptoSignature String?

  // The exact server timestamp fed into the signed manifest. Persisted (not
  // reusing createdAt, whose DB default stamps a hair later) so the signed bytes
  // can be reproduced for verification. timestamp(3) round-trips toISOString().
  sealedAt DateTime?
```

- [ ] **Step 2: Write the migration SQL**

Create `prisma/migrations/20260720210000_transfer_crypto_seal/migration.sql`:

```sql
-- Cryptographically sealed asset handoff: store the Ed25519 seal and the exact
-- signed timestamp on each receipt. Both nullable + additive (no backfill),
-- safe to apply online. No index (neither column is filtered or sorted on).
ALTER TABLE "Transfer" ADD COLUMN "cryptoSignature" TEXT;
ALTER TABLE "Transfer" ADD COLUMN "sealedAt" TIMESTAMP(3);
```

- [ ] **Step 3: Apply the migration and regenerate the client**

Run:
```bash
npx prisma migrate deploy && npx prisma generate
```
Expected: "All migrations have been successfully applied." (or "No pending migrations" if already applied), then "Generated Prisma Client".

- [ ] **Step 4: Verify the client has the new fields**

Run:
```bash
npx tsc --noEmit
```
Expected: no errors. (Confirms the schema + generated types are consistent.)

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260720210000_transfer_crypto_seal
git commit -m "feat: add Transfer.cryptoSignature + sealedAt columns"
```

---

### Task 2: `crypto.ts` — canonicalize, sign, verify

**Files:**
- Create: `src/lib/crypto.ts`
- Test: `src/lib/crypto.test.ts`

**Interfaces:**
- Produces:
  - `canonicalize(value: unknown): string`
  - `generateCryptographicSeal(manifestData: object): string | null`
  - `verifyCryptographicSeal(manifestData: object, signatureBase64: string): boolean`
  - `class CryptoKeyUnavailableError extends Error`

- [ ] **Step 1: Write the failing test**

Create `src/lib/crypto.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { canonicalize, generateCryptographicSeal, verifyCryptographicSeal, CryptoKeyUnavailableError } from "./crypto";

const saved = process.env.SIGNING_PRIVATE_KEY;
function setKey() {
  const { privateKey } = generateKeyPairSync("ed25519");
  process.env.SIGNING_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}
afterEach(() => {
  if (saved === undefined) delete process.env.SIGNING_PRIVATE_KEY;
  else process.env.SIGNING_PRIVATE_KEY = saved;
});

describe("canonicalize", () => {
  it("is key-order independent", () => {
    expect(canonicalize({ a: 1, b: [2, 3] })).toBe(canonicalize({ b: [2, 3], a: 1 }));
  });
  it("is NOT array-order independent", () => {
    expect(canonicalize({ a: [1, 2] })).not.toBe(canonicalize({ a: [2, 1] }));
  });
});

describe("generate + verify round trip", () => {
  it("verifies a freshly generated seal", () => {
    setKey();
    const sig = generateCryptographicSeal({ x: 1, y: "z" });
    expect(sig).toBeTypeOf("string");
    expect(verifyCryptographicSeal({ y: "z", x: 1 }, sig as string)).toBe(true);
  });
  it("fails verification when the manifest is altered", () => {
    setKey();
    const sig = generateCryptographicSeal({ x: 1 }) as string;
    expect(verifyCryptographicSeal({ x: 2 }, sig)).toBe(false);
  });
  it("returns null from generate when the key is unset", () => {
    delete process.env.SIGNING_PRIVATE_KEY;
    expect(generateCryptographicSeal({ x: 1 })).toBeNull();
  });
  it("throws CryptoKeyUnavailableError from verify when the key is unset", () => {
    delete process.env.SIGNING_PRIVATE_KEY;
    expect(() => verifyCryptographicSeal({ x: 1 }, "AA==")).toThrow(CryptoKeyUnavailableError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/crypto.test.ts`
Expected: FAIL — cannot resolve `./crypto` / exports not defined.

- [ ] **Step 3: Write the implementation**

Create `src/lib/crypto.ts`:

```ts
import "server-only";
import { sign, verify, createPublicKey } from "node:crypto";

/** Deterministic JSON: recursively sort object keys so the signed byte string is
 *  reproducible. Arrays keep order — callers pre-sort arrays whose order isn't
 *  already deterministic (see seal.ts item sort). Primitives via JSON.stringify. */
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

/** Missing key is a config problem the verify path reports as "can't verify". */
export class CryptoKeyUnavailableError extends Error {}

function privateKeyPem(): string | null {
  // Un-escape single-line \n PEMs from .env; no-op on real newlines (Vercel).
  return process.env.SIGNING_PRIVATE_KEY?.replace(/\\n/g, "\n") ?? null;
}

/** Ed25519 seal (base64) over the canonical manifest. Best-effort: returns null
 *  + logs (never the key) if the key is absent or signing throws, so sealing
 *  never blocks a handoff. Ed25519 hashes internally — algorithm arg is null. */
export function generateCryptographicSeal(manifestData: object): string | null {
  const pem = privateKeyPem();
  if (!pem) {
    console.error("[crypto] SIGNING_PRIVATE_KEY unset; storing receipt unsealed.");
    return null;
  }
  try {
    return sign(null, Buffer.from(canonicalize(manifestData), "utf8"), pem).toString("base64");
  } catch (err) {
    console.error("[crypto] seal generation failed; storing receipt unsealed:", err);
    return null;
  }
}

/** Verify a base64 Ed25519 seal against the canonical manifest. The public key is
 *  derived from SIGNING_PRIVATE_KEY (no separate env var). Throws
 *  CryptoKeyUnavailableError when no key is configured; returns false for a
 *  genuine signature mismatch (tamper). */
export function verifyCryptographicSeal(manifestData: object, signatureBase64: string): boolean {
  const pem = privateKeyPem();
  if (!pem) throw new CryptoKeyUnavailableError("SIGNING_PRIVATE_KEY unset");
  const publicKey = createPublicKey(pem);
  return verify(null, Buffer.from(canonicalize(manifestData), "utf8"), publicKey, Buffer.from(signatureBase64, "base64"));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/crypto.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/crypto.ts src/lib/crypto.test.ts
git commit -m "feat: add Ed25519 seal sign/verify crypto util"
```

---

### Task 3: `seal.ts` — the shared manifest builder

**Files:**
- Create: `src/modules/transfers/seal.ts`
- Test: `src/modules/transfers/seal.test.ts`

**Interfaces:**
- Consumes: `canonicalize` from `@/lib/crypto` (test only); `ReceiptWithLines` type from `./transfers.service`.
- Produces:
  - `type ManifestInput = { receiptNumber: string; actingUserId: string | null; sealedAt: Date; receiver: { isDcsim: boolean; name: string; rank: string | null; unit: string | null; contact: string | null; email: string | null }; receiverSignature: string; items: { serialNumber: string; make: string; model: string }[] }`
  - `buildHandoffManifest(input: ManifestInput): object`
  - `manifestFromTransfer(t: ReceiptWithLines): object | null`

- [ ] **Step 1: Write the failing test**

Create `src/modules/transfers/seal.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { canonicalize } from "@/lib/crypto";
import { buildHandoffManifest, manifestFromTransfer, type ManifestInput } from "./seal";

const when = new Date("2026-07-20T18:04:11.482Z");
const base: ManifestInput = {
  receiptNumber: "HR-000123",
  actingUserId: "user-1",
  sealedAt: when,
  receiver: { isDcsim: false, name: "Jane", rank: "SGT", unit: "A Co", contact: "808", email: "j@u.mil" },
  receiverSignature: "data:image/png;base64,AAAA",
  items: [
    { serialNumber: "B7", make: "AN/PVS", model: "14" },
    { serialNumber: "A1", make: "M4", model: "Carbine" },
  ],
};

describe("buildHandoffManifest", () => {
  it("is item-order independent (items sorted by serialNumber)", () => {
    const reversed = { ...base, items: [...base.items].reverse() };
    expect(canonicalize(buildHandoffManifest(base))).toBe(canonicalize(buildHandoffManifest(reversed)));
  });
});

describe("manifestFromTransfer", () => {
  it("reproduces the exact manifest a sealed row was built from", () => {
    const row = {
      receiptNumber: "HR-000123",
      createdByUserId: "user-1",
      sealedAt: when,
      cryptoSignature: "sig",
      receiverIsDcsim: false, receiverName: "Jane", receiverRank: "SGT",
      receiverUnit: "A Co", receiverContact: "808", receiverEmail: "j@u.mil",
      receiverSignature: "data:image/png;base64,AAAA",
      lines: [
        { make: "M4", model: "Carbine", items: [{ serialNumber: "A1" }] },
        { make: "AN/PVS", model: "14", items: [{ serialNumber: "B7" }] },
      ],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(canonicalize(manifestFromTransfer(row as any)!)).toBe(canonicalize(buildHandoffManifest(base)));
  });

  it("returns null for an unsealed row (no sealedAt)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(manifestFromTransfer({ sealedAt: null } as any)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/modules/transfers/seal.test.ts`
Expected: FAIL — cannot resolve `./seal`.

- [ ] **Step 3: Write the implementation**

Create `src/modules/transfers/seal.ts`:

```ts
import "server-only";
import type { ReceiptWithLines } from "./transfers.service";

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
 *  row order; canonicalize() then sorts object keys. Sign and verify BOTH build
 *  the manifest here so they can never drift. */
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

/** Reconstruct the manifest from a persisted receipt. Field mapping mirrors what
 *  createTransfer passed in. Returns null if the row was never sealed. */
export function manifestFromTransfer(t: ReceiptWithLines) {
  if (!t.sealedAt) return null;
  return buildHandoffManifest({
    receiptNumber: t.receiptNumber,
    actingUserId: t.createdByUserId ?? null,
    sealedAt: t.sealedAt,
    receiver: {
      isDcsim: t.receiverIsDcsim,
      name: t.receiverName,
      rank: t.receiverRank ?? null,
      unit: t.receiverUnit ?? null,
      contact: t.receiverContact ?? null,
      email: t.receiverEmail ?? null,
    },
    receiverSignature: t.receiverSignature,
    items: t.lines.flatMap((ln) => ln.items.map((it) => ({ serialNumber: it.serialNumber, make: ln.make, model: ln.model }))),
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/modules/transfers/seal.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/transfers/seal.ts src/modules/transfers/seal.test.ts
git commit -m "feat: add shared handoff manifest builder"
```

---

### Task 4: Seal receipts inside `createTransfer`

**Files:**
- Modify: `src/modules/transfers/transfers.service.ts` (imports at top; `createTransfer` ~lines 42-81)
- Test: `src/modules/transfers/transfers.service.test.ts` (append tests)

**Interfaces:**
- Consumes: `buildHandoffManifest` (Task 3), `generateCryptographicSeal` (Task 2), `Transfer.cryptoSignature`/`sealedAt` columns (Task 1).
- Produces: `createTransfer` now writes `sealedAt` (always) and `cryptoSignature` (string or null) onto the created row.

- [ ] **Step 1: Write the failing tests (append to existing test file)**

Append to `src/modules/transfers/transfers.service.test.ts`:

```ts
import { generateKeyPairSync } from "node:crypto";
import { verifyCryptographicSeal } from "@/lib/crypto";
import { manifestFromTransfer } from "./seal";

describe("createTransfer sealing", () => {
  const savedKey = process.env.SIGNING_PRIVATE_KEY;
  afterEach(() => {
    if (savedKey === undefined) delete process.env.SIGNING_PRIVATE_KEY;
    else process.env.SIGNING_PRIVATE_KEY = savedKey;
  });

  it("stores a verifiable cryptoSignature + sealedAt when the key is set", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    process.env.SIGNING_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

    await createTransfer({ itemIds: ["i1", "i2", "i3"], lines, sender, receiver, receiverSignature: sig, createdByUserId: "u1" });
    const data = vi.mocked(__tx.transfer.create).mock.calls[0][0].data;
    expect(data.sealedAt).toBeInstanceOf(Date);
    expect(data.cryptoSignature).toBeTypeOf("string");

    // The stored seal verifies against the manifest rebuilt from what was written.
    const manifest = manifestFromTransfer({
      receiptNumber: data.receiptNumber, createdByUserId: "u1", sealedAt: data.sealedAt,
      cryptoSignature: data.cryptoSignature,
      receiverIsDcsim: receiver.isDcsim, receiverName: receiver.name, receiverRank: receiver.rank ?? null,
      receiverUnit: receiver.unit ?? null, receiverContact: receiver.contact ?? null, receiverEmail: receiver.email ?? null,
      receiverSignature: sig,
      lines: [
        { make: "M4", model: "Carbine", items: [{ serialNumber: "A1" }, { serialNumber: "A2" }] },
        { make: "AN/PVS", model: "14", items: [{ serialNumber: "B7" }] },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)!;
    expect(verifyCryptographicSeal(manifest, data.cryptoSignature)).toBe(true);
  });

  it("stores a null cryptoSignature (still sealedAt) when the key is unset", async () => {
    delete process.env.SIGNING_PRIVATE_KEY;
    await createTransfer({ itemIds: ["i1", "i2", "i3"], lines, sender, receiver, receiverSignature: sig });
    const data = vi.mocked(__tx.transfer.create).mock.calls[0][0].data;
    expect(data.sealedAt).toBeInstanceOf(Date);
    expect(data.cryptoSignature).toBeNull();
  });
});
```

Also add `afterEach` to the vitest import at the top of the file (change `import { describe, it, expect, vi, beforeEach } from "vitest";` to include `afterEach`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/modules/transfers/transfers.service.test.ts`
Expected: FAIL — `data.sealedAt`/`data.cryptoSignature` are undefined.

- [ ] **Step 3: Wire sealing into `createTransfer`**

In `src/modules/transfers/transfers.service.ts`, add imports near the top (after the existing `./receipt-lines` import):

```ts
import { buildHandoffManifest } from "./seal";
import { generateCryptographicSeal } from "@/lib/crypto";
```

Inside `createTransfer`, in the `$transaction` callback, immediately BEFORE the `return tx.transfer.create({` line, insert:

```ts
    const sealedAt = new Date();
    const manifest = buildHandoffManifest({
      receiptNumber,
      actingUserId: createdByUserId ?? null,
      sealedAt,
      receiver: {
        isDcsim: receiver.isDcsim, name: receiver.name, rank: receiver.rank ?? null,
        unit: receiver.unit ?? null, contact: receiver.contact ?? null, email: receiver.email ?? null,
      },
      receiverSignature,
      items: grouped.flatMap((g) => g.itemIds.map((id, i) => ({ serialNumber: g.serials[i], make: g.make, model: g.model }))),
    });
    const cryptoSignature = generateCryptographicSeal(manifest);
```

Then in the `tx.transfer.create({ data: { ... } })` object, add these two lines alongside the other scalar fields (e.g. right after `createdByUserId: createdByUserId ?? null,`):

```ts
        sealedAt,
        cryptoSignature,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/modules/transfers/transfers.service.test.ts`
Expected: PASS (existing tests + 2 new).

- [ ] **Step 5: Commit**

```bash
git add src/modules/transfers/transfers.service.ts src/modules/transfers/transfers.service.test.ts
git commit -m "feat: seal receipts at creation in createTransfer"
```

---

### Task 5: Admin verification action

**Files:**
- Create: `src/app/admin/actions/verify-seal.ts`
- Test: `src/app/admin/actions/verify-seal.test.ts`

**Interfaces:**
- Consumes: `requireAdmin` (`@/lib/authz`), `getTransferByReceiptNumber` (`@/modules/transfers/transfers.service`), `manifestFromTransfer` (Task 3), `verifyCryptographicSeal` + `CryptoKeyUnavailableError` (Task 2).
- Produces: `verifyReceiptSealAction(receiptNumber: string): Promise<{ status: "VALID" | "TAMPERED" | "UNSEALED" | "CANNOT_VERIFY" | "NOT_FOUND"; sealedAt?: string }>`

- [ ] **Step 1: Write the failing test**

Create `src/app/admin/actions/verify-seal.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";

vi.mock("@/lib/authz", () => ({
  requireAdmin: vi.fn(async () => ({ id: "u1", role: "ADMIN" })),
  AuthError: class AuthError extends Error {},
}));
vi.mock("@/modules/transfers/transfers.service", () => ({
  getTransferByReceiptNumber: vi.fn(),
}));

import { requireAdmin } from "@/lib/authz";
import { getTransferByReceiptNumber } from "@/modules/transfers/transfers.service";
import { generateCryptographicSeal } from "@/lib/crypto";
import { manifestFromTransfer } from "@/modules/transfers/seal";
import { verifyReceiptSealAction } from "./verify-seal";

const savedKey = process.env.SIGNING_PRIVATE_KEY;
function setKey() {
  const { privateKey } = generateKeyPairSync("ed25519");
  process.env.SIGNING_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}
function sealedRow() {
  const row: Record<string, unknown> = {
    receiptNumber: "HR-000123", createdByUserId: "u1", sealedAt: new Date("2026-07-20T18:04:11.482Z"),
    receiverIsDcsim: false, receiverName: "Jane", receiverRank: "SGT", receiverUnit: "A Co",
    receiverContact: "808", receiverEmail: "j@u.mil", receiverSignature: "data:image/png;base64,AAAA",
    lines: [{ make: "M4", model: "Carbine", items: [{ serialNumber: "A1" }] }],
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  row.cryptoSignature = generateCryptographicSeal(manifestFromTransfer(row as any)!);
  return row;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  if (savedKey === undefined) delete process.env.SIGNING_PRIVATE_KEY;
  else process.env.SIGNING_PRIVATE_KEY = savedKey;
});

describe("verifyReceiptSealAction", () => {
  it("returns VALID for an intact sealed receipt", async () => {
    setKey();
    vi.mocked(getTransferByReceiptNumber).mockResolvedValueOnce(sealedRow() as never);
    expect((await verifyReceiptSealAction("HR-000123")).status).toBe("VALID");
  });

  it("returns TAMPERED when a sealed field was altered", async () => {
    setKey();
    const row = sealedRow();
    row.receiverName = "Someone Else"; // mutate AFTER signing
    vi.mocked(getTransferByReceiptNumber).mockResolvedValueOnce(row as never);
    expect((await verifyReceiptSealAction("HR-000123")).status).toBe("TAMPERED");
  });

  it("returns UNSEALED when there is no signature", async () => {
    setKey();
    vi.mocked(getTransferByReceiptNumber).mockResolvedValueOnce({ ...sealedRow(), cryptoSignature: null } as never);
    expect((await verifyReceiptSealAction("HR-000123")).status).toBe("UNSEALED");
  });

  it("returns NOT_FOUND when the receipt is gone", async () => {
    setKey();
    vi.mocked(getTransferByReceiptNumber).mockResolvedValueOnce(null);
    expect((await verifyReceiptSealAction("HR-NOPE")).status).toBe("NOT_FOUND");
  });

  it("returns CANNOT_VERIFY when the key is unset", async () => {
    setKey();
    const signed = sealedRow(); // sign while a key is present...
    delete process.env.SIGNING_PRIVATE_KEY; // ...then remove it before verifying
    vi.mocked(getTransferByReceiptNumber).mockResolvedValueOnce(signed as never);
    expect((await verifyReceiptSealAction("HR-000123")).status).toBe("CANNOT_VERIFY");
  });

  it("rejects a non-admin caller", async () => {
    vi.mocked(requireAdmin).mockRejectedValueOnce(new Error("FORBIDDEN"));
    await expect(verifyReceiptSealAction("HR-000123")).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/app/admin/actions/verify-seal.test.ts`
Expected: FAIL — cannot resolve `./verify-seal`.

- [ ] **Step 3: Write the implementation**

Create `src/app/admin/actions/verify-seal.ts`:

```ts
"use server";
import { requireAdmin } from "@/lib/authz";
import { getTransferByReceiptNumber } from "@/modules/transfers/transfers.service";
import { manifestFromTransfer } from "@/modules/transfers/seal";
import { verifyCryptographicSeal, CryptoKeyUnavailableError } from "@/lib/crypto";

export type SealStatus = "VALID" | "TAMPERED" | "UNSEALED" | "CANNOT_VERIFY" | "NOT_FOUND";

// Admin-only integrity check: re-derive the canonical manifest from the persisted
// receipt and verify its seal. Read-only; never mutates. requireAdmin re-reads
// role/isActive per request, so a demoted admin can't verify.
export async function verifyReceiptSealAction(receiptNumber: string): Promise<{ status: SealStatus; sealedAt?: string }> {
  await requireAdmin();
  const t = await getTransferByReceiptNumber(receiptNumber);
  // Existence isn't guaranteed at click time: the 90-day purge (or another admin)
  // can hard-delete a CLOSED receipt while the tab sits open. Report that
  // distinctly rather than mislabeling a deleted receipt as merely "unsealed".
  if (!t) return { status: "NOT_FOUND" };
  if (!t.cryptoSignature || !t.sealedAt) return { status: "UNSEALED" };
  const manifest = manifestFromTransfer(t); // non-null: sealedAt is present
  try {
    const ok = verifyCryptographicSeal(manifest as object, t.cryptoSignature);
    return { status: ok ? "VALID" : "TAMPERED", sealedAt: t.sealedAt.toISOString() };
  } catch (e) {
    if (e instanceof CryptoKeyUnavailableError) return { status: "CANNOT_VERIFY" };
    console.error("[verifyReceiptSealAction] verify failed:", e);
    return { status: "CANNOT_VERIFY" };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/app/admin/actions/verify-seal.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/app/admin/actions/verify-seal.ts src/app/admin/actions/verify-seal.test.ts
git commit -m "feat: add admin verifyReceiptSealAction"
```

---

### Task 6: "Verify seal" UI on the receipt page

**Files:**
- Create: `src/app/receipts/[receiptNumber]/ReceiptSealVerify.tsx`
- Create: `src/app/receipts/[receiptNumber]/ReceiptSealVerify.test.tsx`
- Modify: `src/app/receipts/[receiptNumber]/page.tsx` (import + render, ~line 11 and ~line 90)

**Interfaces:**
- Consumes: `verifyReceiptSealAction` (Task 5).
- Produces: `<ReceiptSealVerify receiptNumber={string} />` client component.

- [ ] **Step 1: Write the failing test**

Create `src/app/receipts/[receiptNumber]/ReceiptSealVerify.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/app/admin/actions/verify-seal", () => ({ verifyReceiptSealAction: vi.fn() }));
import { verifyReceiptSealAction } from "@/app/admin/actions/verify-seal";
import { ReceiptSealVerify } from "./ReceiptSealVerify";

describe("ReceiptSealVerify", () => {
  it("shows the VALID message after a successful verify", async () => {
    vi.mocked(verifyReceiptSealAction).mockResolvedValueOnce({ status: "VALID", sealedAt: "2026-07-20T18:04:11.482Z" });
    render(<ReceiptSealVerify receiptNumber="HR-000123" />);
    await userEvent.click(screen.getByRole("button", { name: /verify seal/i }));
    expect(await screen.findByText(/seal valid/i)).toBeTruthy();
  });

  it("shows the TAMPERED message when verification fails", async () => {
    vi.mocked(verifyReceiptSealAction).mockResolvedValueOnce({ status: "TAMPERED" });
    render(<ReceiptSealVerify receiptNumber="HR-000123" />);
    await userEvent.click(screen.getByRole("button", { name: /verify seal/i }));
    expect(await screen.findByText(/seal invalid/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/app/receipts/[receiptNumber]/ReceiptSealVerify.test.tsx`
Expected: FAIL — cannot resolve `./ReceiptSealVerify`.

- [ ] **Step 3: Write the component**

Create `src/app/receipts/[receiptNumber]/ReceiptSealVerify.tsx`:

```tsx
"use client";
import { useState, useTransition } from "react";
import { verifyReceiptSealAction, type SealStatus } from "@/app/admin/actions/verify-seal";

// Admin-only control (rendered only for admins on the receipt page). Verifies the
// stored seal and shows the result. Kept a separate client component so the
// client boundary doesn't pull the whole receipt page into the bundle
// (mirrors ReceiptDueAtControls / NotifyPickupButton).
const LABELS: Record<SealStatus, string> = {
  VALID: "Seal valid — the receipt is intact.",
  TAMPERED: "SEAL INVALID — a sealed field was altered.",
  UNSEALED: "No seal on this receipt.",
  CANNOT_VERIFY: "Can't verify — signing key not configured.",
  NOT_FOUND: "Receipt no longer exists — refresh the page.",
};

export function ReceiptSealVerify({ receiptNumber }: { receiptNumber: string }) {
  const [result, setResult] = useState<{ status: SealStatus; sealedAt?: string } | null>(null);
  const [pending, start] = useTransition();

  return (
    <div className="row" style={{ gap: 8, alignItems: "center" }}>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        disabled={pending}
        onClick={() => start(async () => setResult(await verifyReceiptSealAction(receiptNumber)))}
      >
        {pending ? "Verifying…" : "Verify seal"}
      </button>
      {result && (
        <span role="status" className={result.status === "VALID" ? "alert-success" : "alert-error"}>
          {LABELS[result.status]}
          {result.sealedAt ? ` (sealed ${new Date(result.sealedAt).toLocaleString()})` : ""}
        </span>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/app/receipts/[receiptNumber]/ReceiptSealVerify.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Render it on the receipt page (admin-only)**

In `src/app/receipts/[receiptNumber]/page.tsx`, add the import after the `ReceiptDueAtControls` import (~line 11):

```tsx
import { ReceiptSealVerify } from "./ReceiptSealVerify";
```

Then, inside the info `card` div, immediately after the existing line
`{isAdmin && !closed && <ReceiptDueAtControls receiptNumber={t.receiptNumber} />}` (~line 90), add (note: NO `!closed` gate — closed receipts are exactly the ones that get purged/tampered, so they must stay verifiable):

```tsx
          {isAdmin && <ReceiptSealVerify receiptNumber={t.receiptNumber} />}
```

- [ ] **Step 6: Verify the page still typechecks and the suite is green**

Run: `npx tsc --noEmit && npx vitest run src/app/receipts src/app/admin/actions/verify-seal.test.ts`
Expected: no type errors; all listed tests PASS.

- [ ] **Step 7: Commit**

```bash
git add "src/app/receipts/[receiptNumber]/ReceiptSealVerify.tsx" "src/app/receipts/[receiptNumber]/ReceiptSealVerify.test.tsx" "src/app/receipts/[receiptNumber]/page.tsx"
git commit -m "feat: add admin Verify seal control to receipt page"
```

---

### Task 7: Documentation (CHANGELOG, README, .env.example)

**Files:**
- Modify: `CHANGELOG.md` (under the existing `## 2026-07-20` section)
- Modify: `README.md` (Environment-variables table ~lines 64-70)
- Modify: `.env.example` (append a commented entry)

**Interfaces:** none (docs only).

- [ ] **Step 1: Add the CHANGELOG entry**

In `CHANGELOG.md`, under `## 2026-07-20`, add a bullet at the TOP of the existing `### Added` list:

```markdown
- **Cryptographically sealed asset handoff.** Every hand receipt is now sealed at
  creation with an Ed25519 signature over a canonical manifest of the handoff
  (receipt number, items, recipient details + signature, acting technician, and a
  server timestamp), stored on the receipt. Admins get a **Verify seal** button on
  the receipt page that re-derives the manifest and reports **Valid / Tampered /
  Unsealed / Can't-verify / Not-found** — making after-the-fact edits to a receipt
  detectable (non-repudiation). Sealing is best-effort: if the signing key isn't
  configured, receipts are still created, just unsealed.
```

Then add a `### Notes` subsection at the END of the `## 2026-07-20` section (after its last subsection):

```markdown
### Notes
- New env var **`SIGNING_PRIVATE_KEY`** (Ed25519 PKCS#8 PEM) signs receipt seals.
  Generate a keypair:
  `node -e "const {generateKeyPairSync}=require('crypto');const {privateKey,publicKey}=generateKeyPairSync('ed25519');console.log(privateKey.export({type:'pkcs8',format:'pem'}));console.log(publicKey.export({type:'spki',format:'pem'}))"`
  Set the private key in `.env.local` (one line, `\n`-escaped) for dev and in Vercel
  (multi-line, as-is) for prod — use separate keys. The public key for verification
  is derived from the private key at runtime, so there is no `SIGNING_PUBLIC_KEY`
  var; keep the public key only if you later want offline/external verification.
  Migration `20260720210000_transfer_crypto_seal` adds the `cryptoSignature` and
  `sealedAt` columns (nullable, additive — no backfill).
```

- [ ] **Step 2: Add the README env-var row**

In `README.md`, add this row to the Environment-variables table (after the `APP_URL` row, ~line 69):

```markdown
| `SIGNING_PRIVATE_KEY` | Ed25519 PKCS#8 PEM that signs each receipt's non-repudiation seal. Best-effort — unset means receipts are created unsealed. Verification (admin-only) derives the public key from it; no separate public-key var. |
```

- [ ] **Step 3: Add the `.env.example` entry**

Append to `.env.example`:

```
# Ed25519 private key (PKCS#8 PEM) that signs each hand receipt's non-repudiation
# seal. Optional/best-effort: unset means receipts are created unsealed. Generate:
#   node -e "const {generateKeyPairSync}=require('crypto');const {privateKey}=generateKeyPairSync('ed25519');console.log(privateKey.export({type:'pkcs8',format:'pem'}))"
# Dev: one line, \n-escaped, quoted. Prod (Vercel): paste the multi-line PEM as-is.
SIGNING_PRIVATE_KEY=
```

- [ ] **Step 4: Verify the docs read correctly**

Run: `git diff --stat`
Expected: `CHANGELOG.md`, `README.md`, `.env.example` listed as modified. Re-read each change to confirm no typos and the changelog date is `## 2026-07-20`.

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md README.md .env.example
git commit -m "docs: document sealed asset handoff + SIGNING_PRIVATE_KEY"
```

---

## Final verification (after all tasks)

- [ ] Run the full suite: `npx vitest run` — expected: all green (DB up; no other agent running tests, per repo constraint).
- [ ] Typecheck + lint: `npx tsc --noEmit && npm run lint` — expected: clean.
- [ ] Manual smoke (dev server with `SIGNING_PRIVATE_KEY` in `.env.local`): create a receipt, open it as an admin, click **Verify seal** → **Valid**. Then `UPDATE "Transfer" SET "receiverName"='X' WHERE "receiptNumber"='HR-…'` in the DB and click again → **Seal invalid**.
- [ ] **Before pushing:** repo guardrail requires `/code-review xhigh` on the branch, then record it (`git rev-parse HEAD > .git/xhigh-review-ok`) before `git push`. Do not push without it.

## Spec coverage map

- Schema `cryptoSignature` + `sealedAt` → Task 1
- `crypto.ts` sign/verify/canonicalize + `CryptoKeyUnavailableError` → Task 2
- Shared `seal.ts` manifest builder + `manifestFromTransfer` → Task 3
- Sign at creation (`createTransfer`, `requireUser` unchanged, best-effort) → Task 4
- Admin verify action, 5 statuses incl. NOT_FOUND, `requireAdmin` → Task 5
- Admin-only Verify-seal UI on receipt page → Task 6
- CHANGELOG + README + `.env.example` (public key derived, no `SIGNING_PUBLIC_KEY`) → Task 7
- Best-effort failure behavior → Tasks 2 & 4; verification read-only → Task 5
- Out of scope (returns/audits sealing, key rotation, external CLI, public exposure) → not implemented, by design
