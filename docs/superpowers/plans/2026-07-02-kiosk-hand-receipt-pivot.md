# Kiosk Hand-Receipt Pivot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the app from an account-per-person, two-device custody-transfer model into a single-device kiosk where an authenticated operator types both parties' details, the recipient signs on-screen, and a hand receipt is generated, emailed, and publicly searchable.

**Architecture:** Party details become denormalized snapshot columns on `Transfer` (no more from/to `User` FKs). A logged-in operator (shared DCSIM/admin account or an admin-created regular user) drives a single `/new` flow. Public, no-login pages let anyone search receipts by serial/receipt number and download the PDF. Email is sent via a small pluggable `EmailSender` (Resend over `fetch`, no SDK).

**Tech Stack:** Next.js 16.2.9 (App Router, `proxy.ts` middleware, Server Actions, Route Handlers), Prisma 7 + PostgreSQL, next-auth v5 (credentials), pdf-lib, qrcode, Zod v4, Vitest.

## Global Constraints

- **Next.js 16 is non-standard.** Before writing routing/middleware/server-action code, consult `node_modules/next/dist/docs/`. Mirror patterns already in this repo: route `params` are `Promise<…>` and must be `await`ed; middleware lives in `src/proxy.ts` exporting `proxy`; server actions are `"use server"` files returning `{ error }`/`{ ok }` shapes consumed by `useActionState`.
- **Follow codegraph/Context7 rules** in CLAUDE.md when exploring or touching external libs.
- **Auth:** all transfer creation and item logging require `requireUser()`. Public routes: `/`, `/login`, `/receipts/*`. Everything else authed; `/admin/*` requires `requireAdmin()`.
- **Party rules:** a DCSIM side requires only `name` (tech name). A non-DCSIM side requires `rank`, `name`, `unit`, `contact`, `email` (valid). Both-sides-DCSIM is rejected. Recipient signature (`data:image/png;base64,…`, ≤ 5,000,000 chars) is always required.
- **Dates** display in HST via `@/lib/datetime` (already implemented).
- **Commit** after each task's tests pass. Do not push unless asked. Commit trailer:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- **Run tests** with `npm test` (Vitest). Type/build check with `npx tsc --noEmit` and `npm run build`.

---

## File Structure

**Created**
- `src/modules/transfers/transfers.schema.ts` — Zod party + transfer validation
- `src/modules/transfers/receipt-number.ts` — receipt-number generator
- `src/lib/email.ts` — `EmailSender` interface, Resend + stub, `getEmailSender`
- `src/modules/receipts/send-receipt-email.ts` — email non-DCSIM parties the receipt link
- `src/app/new/page.tsx` — kiosk transfer flow (server component)
- `src/app/new/NewTransferForm.tsx` — kiosk transfer form (client)
- `src/app/receipts/[receiptNumber]/page.tsx` — public receipt view
- `src/app/receipts/[receiptNumber]/pdf/route.ts` — public PDF stream
- `src/components/ReceiptSearch.tsx` — public search form (client)
- `src/app/actions/receipts.ts` — public search server action
- Tests alongside each module (`*.test.ts`)

**Modified**
- `prisma/schema.prisma`, new migration under `prisma/migrations/…`, `prisma/seed.ts`
- `src/modules/items/items.schema.ts`, `src/modules/items/items.service.ts`
- `src/modules/users/users.schema.ts`, `src/modules/users/users.service.ts`
- `src/modules/transfers/transfers.service.ts` (rewrite), `transfers.errors.ts`
- `src/modules/items/qr.ts`, `src/modules/receipts/hand-receipt.ts`
- `src/app/actions/transfers.ts` (rewrite), `src/app/actions/auth.ts`
- `src/app/page.tsx` (→ public search), `src/proxy.ts`
- `src/app/admin/actions/items.ts`, `src/app/admin/actions/users.ts`
- `src/app/admin/users/NewUserForm.tsx`, admin item pages/forms
- `.env.example`

**Deleted**
- `src/app/register/`, `src/app/dashboard/`, `src/app/i/`
- `src/app/transfers/[id]/` (page + `SignForm.tsx`), `src/app/transfers/[id]/receipt/route.ts`
- `src/components/InitiateTransferForm.tsx`, `src/components/OverrideForm.tsx`
- `src/app/admin/actions/override.ts`
- Obsolete tests: `initiate.test.ts`, `accept-cancel-override.test.ts`, `queries.test.ts` (rewritten in Task 3)

---

## Task 1: Data model, migration, and data wipe

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_kiosk_pivot/migration.sql`
- Modify: `prisma/seed.ts`

**Interfaces:**
- Produces: Prisma models `User { …, unit String?, contactNumber String? }`, `Item { make, model, serialNumber, homeUnit String?, notes String?, status, createdById }`, `Transfer { id, receiptNumber @unique, itemId, itemSummary, senderIsDcsim, senderName, senderRank?, senderUnit?, senderContact?, senderEmail?, receiverIsDcsim, receiverName, receiverRank?, receiverUnit?, receiverContact?, receiverEmail?, receiverSignature, createdByUserId?, status TransferStatus, createdAt }`, enum `TransferStatus { COMPLETED, VOID }`.

- [ ] **Step 1: Rewrite the three models in `prisma/schema.prisma`**

Keep the `generator`, `datasource`, and `Role`/`ItemStatus` enums as-is. Replace the `User`, `Item`, `Transfer` models and the `TransferStatus` enum with:

```prisma
model User {
  id            String   @id @default(cuid())
  rank          String?
  name          String
  email         String   @unique
  unit          String?
  contactNumber String?
  passwordHash  String
  role          Role     @default(USER)
  isActive      Boolean  @default(true)
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  createdItems     Item[]     @relation("CreatedItems")
  createdTransfers Transfer[] @relation("CreatedTransfers")
}

model Item {
  id           String     @id @default(cuid())
  make         String
  model        String
  serialNumber String
  homeUnit     String?
  notes        String?
  status       ItemStatus @default(ACTIVE)
  createdBy    User       @relation("CreatedItems", fields: [createdById], references: [id])
  createdById  String
  transfers    Transfer[]
  createdAt    DateTime   @default(now())
  updatedAt    DateTime   @updatedAt
}

enum TransferStatus {
  COMPLETED
  VOID
}

model Transfer {
  id            String @id @default(cuid())
  receiptNumber String @unique
  item          Item   @relation(fields: [itemId], references: [id])
  itemId        String
  itemSummary   String

  senderIsDcsim Boolean @default(false)
  senderName    String
  senderRank    String?
  senderUnit    String?
  senderContact String?
  senderEmail   String?

  receiverIsDcsim Boolean @default(false)
  receiverName    String
  receiverRank    String?
  receiverUnit    String?
  receiverContact String?
  receiverEmail   String?

  receiverSignature String

  createdByUser   User?   @relation("CreatedTransfers", fields: [createdByUserId], references: [id])
  createdByUserId String?

  status    TransferStatus @default(COMPLETED)
  createdAt DateTime       @default(now())
}
```

- [ ] **Step 2: Create the migration folder + SQL**

Create `prisma/migrations/20260702_kiosk_pivot/migration.sql`. This wipes dependent data first (keep admin), then reshapes tables. Adjust the timestamp prefix to be lexically after the latest existing migration (`20260701233732_add_user_rank`).

```sql
-- Wipe transfers + items + non-admin users (keep the admin account).
DELETE FROM "Transfer";
DELETE FROM "Item";
DELETE FROM "User" WHERE "role" <> 'ADMIN';

-- USER: add kiosk party fields.
ALTER TABLE "User" ADD COLUMN "unit" TEXT;
ALTER TABLE "User" ADD COLUMN "contactNumber" TEXT;

-- ITEM: rename homeLocation -> homeUnit, drop assetTag + currentHolder.
ALTER TABLE "Item" RENAME COLUMN "homeLocation" TO "homeUnit";
ALTER TABLE "Item" DROP CONSTRAINT IF EXISTS "Item_currentHolderId_fkey";
ALTER TABLE "Item" DROP COLUMN IF EXISTS "currentHolderId";
ALTER TABLE "Item" DROP COLUMN IF EXISTS "assetTag";

-- TRANSFER: drop old party/override columns, add snapshot columns.
DROP INDEX IF EXISTS "one_pending_transfer_per_item";
ALTER TABLE "Transfer" DROP CONSTRAINT IF EXISTS "Transfer_fromUserId_fkey";
ALTER TABLE "Transfer" DROP CONSTRAINT IF EXISTS "Transfer_toUserId_fkey";
ALTER TABLE "Transfer" DROP COLUMN "fromUserId";
ALTER TABLE "Transfer" DROP COLUMN "toUserId";
ALTER TABLE "Transfer" DROP COLUMN "fromUserName";
ALTER TABLE "Transfer" DROP COLUMN "toUserName";
ALTER TABLE "Transfer" DROP COLUMN "isOverride";
ALTER TABLE "Transfer" DROP COLUMN "actingAdminId";
ALTER TABLE "Transfer" DROP COLUMN "signatureImage";
ALTER TABLE "Transfer" DROP COLUMN "initiatedAt";
ALTER TABLE "Transfer" DROP COLUMN "signedAt";
ALTER TABLE "Transfer" DROP COLUMN "cancelledAt";

ALTER TABLE "Transfer" ADD COLUMN "receiptNumber" TEXT NOT NULL;
ALTER TABLE "Transfer" ADD COLUMN "senderIsDcsim" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Transfer" ADD COLUMN "senderName" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Transfer" ADD COLUMN "senderRank" TEXT;
ALTER TABLE "Transfer" ADD COLUMN "senderUnit" TEXT;
ALTER TABLE "Transfer" ADD COLUMN "senderContact" TEXT;
ALTER TABLE "Transfer" ADD COLUMN "senderEmail" TEXT;
ALTER TABLE "Transfer" ADD COLUMN "receiverIsDcsim" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Transfer" ADD COLUMN "receiverName" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Transfer" ADD COLUMN "receiverRank" TEXT;
ALTER TABLE "Transfer" ADD COLUMN "receiverUnit" TEXT;
ALTER TABLE "Transfer" ADD COLUMN "receiverContact" TEXT;
ALTER TABLE "Transfer" ADD COLUMN "receiverEmail" TEXT;
ALTER TABLE "Transfer" ADD COLUMN "receiverSignature" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Transfer" ADD COLUMN "createdByUserId" TEXT;

-- Drop the DEFAULTs used only to satisfy NOT NULL on the (now empty) table.
ALTER TABLE "Transfer" ALTER COLUMN "senderName" DROP DEFAULT;
ALTER TABLE "Transfer" ALTER COLUMN "receiverName" DROP DEFAULT;
ALTER TABLE "Transfer" ALTER COLUMN "receiverSignature" DROP DEFAULT;

-- The old `TransferStatus` already exists with PENDING/COMPLETED/CANCELLED.
-- Normalize to COMPLETED/VOID. Table is empty, so just add VOID and drop the
-- unused labels is complex in PG; keeping extra labels is harmless, but to
-- match the schema add VOID if missing.
ALTER TYPE "TransferStatus" ADD VALUE IF NOT EXISTS 'VOID';

CREATE UNIQUE INDEX "Transfer_receiptNumber_key" ON "Transfer"("receiptNumber");
ALTER TABLE "Transfer"
  ADD CONSTRAINT "Transfer_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

> Note: Prisma's `enum` in `schema.prisma` lists only `COMPLETED, VOID`; Postgres keeps the legacy `PENDING`/`CANCELLED` labels physically but they're unused. This mismatch is acceptable (Prisma validates values it writes, not the full PG type). If you prefer a clean type, replace the `ALTER TYPE` block with a drop-and-recreate of the enum on the empty column.

- [ ] **Step 3: Update the seed to only seed admin (already does), verify no removed fields**

`prisma/seed.ts` already seeds only the admin and touches no removed fields — confirm it still compiles after `prisma generate`. No edit expected.

- [ ] **Step 4: Apply migration + regenerate client**

Run:
```bash
npx prisma migrate dev --name kiosk_pivot
npx prisma generate
```
Expected: migration applies; `@prisma/client` regenerates with the new `Transfer`/`Item`/`User` types. If `migrate dev` wants to create its own migration because the SQL differs, reconcile so the committed SQL matches the schema (use `npx prisma migrate diff` to compare).

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: FAILs in `transfers.service.ts`, `hand-receipt.ts`, receipt route, `/i` page, etc. (they reference removed fields). This is expected — those are rewritten/deleted in later tasks. Confirm the *schema/seed* themselves aren't the source of errors.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations prisma/seed.ts
git commit -m "feat(db): reshape schema for kiosk hand-receipt model"
```

---

## Task 2: Validation schemas (item, user, party/transfer)

**Files:**
- Modify: `src/modules/items/items.schema.ts`
- Modify: `src/modules/users/users.schema.ts`
- Create: `src/modules/transfers/transfers.schema.ts`
- Create: `src/modules/transfers/transfers.schema.test.ts`

**Interfaces:**
- Produces: `newItemSchema` (fields: make, model, serialNumber, homeUnit?, notes?), `NewItemInput`; `newUserSchema` gains `unit?`, `contactNumber?`; `partySchema` → `PartyInput { isDcsim: boolean; name: string; rank?, unit?, contact?, email? }`; `transferSchema` → `TransferInput { itemId, sender: PartyInput, receiver: PartyInput, receiverSignature }`. Constants `SIGNATURE_PREFIX`, `MAX_SIGNATURE_BYTES` exported from `transfers.schema.ts`.

- [ ] **Step 1: Reduce `items.schema.ts`**

Replace file contents:
```ts
import { z } from "zod";

const optional = z
  .string()
  .trim()
  .optional()
  .or(z.literal(""))
  .transform((v) => v || undefined);

export const newItemSchema = z.object({
  make: z.string().trim().min(1, "Make is required"),
  model: z.string().trim().min(1, "Model is required"),
  serialNumber: z.string().trim().min(1, "Serial number is required"),
  homeUnit: optional,
  notes: optional,
});

export type NewItemInput = z.infer<typeof newItemSchema>;
```

- [ ] **Step 2: Add `unit`/`contactNumber` to `users.schema.ts`**

In `newUserSchema`, add two optional fields (mirroring the existing `rank` transform):
```ts
const optionalText = z
  .string()
  .trim()
  .optional()
  .or(z.literal(""))
  .transform((v) => v || undefined);
```
and inside `newUserSchema` object add:
```ts
  unit: optionalText,
  contactNumber: optionalText,
```
Leave `registerSchema` in place for now (Task 8 deletes it).

- [ ] **Step 3: Write the failing party/transfer schema test**

Create `src/modules/transfers/transfers.schema.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { partySchema, transferSchema, SIGNATURE_PREFIX } from "./transfers.schema";

const sig = SIGNATURE_PREFIX + "AAAA";
const fullParty = { isDcsim: false, name: "Jane Doe", rank: "SGT", unit: "A Co", contact: "808-555-1212", email: "jane@unit.mil" };
const dcsimParty = { isDcsim: true, name: "SPC Tech" };

describe("partySchema", () => {
  it("accepts a full non-DCSIM party and lowercases email", () => {
    const p = partySchema.parse({ ...fullParty, email: "Jane@Unit.Mil" });
    expect(p.email).toBe("jane@unit.mil");
  });
  it("accepts a DCSIM party with only a name", () => {
    expect(partySchema.parse(dcsimParty).name).toBe("SPC Tech");
  });
  it("rejects a non-DCSIM party missing unit/contact/email", () => {
    const r = partySchema.safeParse({ isDcsim: false, name: "No Fields" });
    expect(r.success).toBe(false);
  });
  it("rejects a non-DCSIM party with an invalid email", () => {
    const r = partySchema.safeParse({ ...fullParty, email: "not-an-email" });
    expect(r.success).toBe(false);
  });
});

describe("transferSchema", () => {
  it("accepts a valid DCSIM-sender transfer", () => {
    const r = transferSchema.safeParse({ itemId: "itm1", sender: dcsimParty, receiver: fullParty, receiverSignature: sig });
    expect(r.success).toBe(true);
  });
  it("rejects when both parties are DCSIM", () => {
    const r = transferSchema.safeParse({ itemId: "itm1", sender: dcsimParty, receiver: { isDcsim: true, name: "Other Tech" }, receiverSignature: sig });
    expect(r.success).toBe(false);
  });
  it("rejects a missing/short signature", () => {
    const r = transferSchema.safeParse({ itemId: "itm1", sender: dcsimParty, receiver: fullParty, receiverSignature: "nope" });
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm test -- transfers.schema`
Expected: FAIL — `Cannot find module './transfers.schema'`.

- [ ] **Step 5: Implement `transfers.schema.ts`**

Create `src/modules/transfers/transfers.schema.ts`:
```ts
import { z } from "zod";

export const SIGNATURE_PREFIX = "data:image/png;base64,";
export const MAX_SIGNATURE_BYTES = 5_000_000;

const optional = z
  .string()
  .trim()
  .optional()
  .or(z.literal(""))
  .transform((v) => v || undefined);

const emailRe = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const partySchema = z
  .object({
    isDcsim: z.boolean(),
    name: z.string().trim().min(1, "Name is required"),
    rank: optional,
    unit: optional,
    contact: optional,
    email: optional.transform((v) => (v ? v.toLowerCase() : undefined)),
  })
  .superRefine((p, ctx) => {
    if (p.isDcsim) return; // DCSIM side only needs a technician name
    const required = ["rank", "unit", "contact", "email"] as const;
    for (const f of required) {
      if (!p[f]) ctx.addIssue({ code: "custom", path: [f], message: `${f} is required` });
    }
    if (p.email && !emailRe.test(p.email)) {
      ctx.addIssue({ code: "custom", path: ["email"], message: "A valid email is required" });
    }
  });

export type PartyInput = z.infer<typeof partySchema>;

export const transferSchema = z
  .object({
    itemId: z.string().min(1, "An item is required"),
    sender: partySchema,
    receiver: partySchema,
    receiverSignature: z
      .string()
      .startsWith(SIGNATURE_PREFIX, "Recipient signature is required")
      .max(MAX_SIGNATURE_BYTES, "Signature is too large"),
  })
  .superRefine((t, ctx) => {
    if (t.sender.isDcsim && t.receiver.isDcsim) {
      ctx.addIssue({ code: "custom", path: ["receiver", "isDcsim"], message: "Both parties cannot be DCSIM" });
    }
  });

export type TransferInput = z.infer<typeof transferSchema>;
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- transfers.schema`
Expected: PASS (all cases).

- [ ] **Step 7: Commit**

```bash
git add src/modules/items/items.schema.ts src/modules/users/users.schema.ts src/modules/transfers/transfers.schema.ts src/modules/transfers/transfers.schema.test.ts
git commit -m "feat(validation): reduced item schema, party/transfer schema, user unit/contact"
```

---

## Task 3: Receipt-number generator + transfer service rewrite

**Files:**
- Create: `src/modules/transfers/receipt-number.ts`
- Rewrite: `src/modules/transfers/transfers.service.ts`
- Modify: `src/modules/transfers/transfers.errors.ts`
- Create: `src/modules/transfers/transfers.service.test.ts`
- Delete: `src/modules/transfers/initiate.test.ts`, `src/modules/transfers/accept-cancel-override.test.ts`, `src/modules/transfers/queries.test.ts`

**Interfaces:**
- Consumes: `PartyInput`, `TransferInput` (Task 2); Prisma `Transfer`/`Item` (Task 1).
- Produces:
  - `generateReceiptNumber(): string` → `"HR-XXXXXXXX"` (8 uppercase hex).
  - `createTransfer(input: TransferInput & { createdByUserId?: string }): Promise<Transfer>`
  - `getTransferByReceiptNumber(receiptNumber: string): Promise<(Transfer & { item: Item }) | null>`
  - `searchReceipts(query: string): Promise<Array<Transfer & { item: Item }>>` — matches exact `receiptNumber` (case-insensitive) OR `item.serialNumber` (case-insensitive), newest first.
  - `getLastReceiver(itemId: string): Promise<PartyInput | null>` — receiver snapshot of the item's most recent COMPLETED transfer, for sender pre-fill.
  - `getItemHistory(itemId): Promise<Transfer[]>` (kept).

- [ ] **Step 1: Write the failing receipt-number test**

Create `src/modules/transfers/receipt-number.ts` test inside `transfers.service.test.ts` (grouped). First the generator, which is pure and unit-testable. Create `src/modules/transfers/receipt-number.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { generateReceiptNumber } from "./receipt-number";

describe("generateReceiptNumber", () => {
  it("matches HR- followed by 8 uppercase hex chars", () => {
    expect(generateReceiptNumber()).toMatch(/^HR-[0-9A-F]{8}$/);
  });
  it("is different across calls", () => {
    expect(generateReceiptNumber()).not.toBe(generateReceiptNumber());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- receipt-number`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `receipt-number.ts`**

```ts
import { randomBytes } from "node:crypto";

// Human-facing, non-sequential receipt id, e.g. "HR-1A2B3C4D". Non-enumerable
// by design: receipts are publicly downloadable by number.
export function generateReceiptNumber(): string {
  return `HR-${randomBytes(4).toString("hex").toUpperCase()}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- receipt-number`
Expected: PASS.

- [ ] **Step 5: Trim `transfers.errors.ts` to the codes still used**

Set the error union to the codes the new service throws:
```ts
export class TransferError extends Error {
  constructor(public code: "ITEM_NOT_FOUND" | "ITEM_RETIRED" | "RECEIPT_COLLISION") {
    super(code);
    this.name = "TransferError";
  }
}
```

- [ ] **Step 6: Delete the obsolete service tests**

```bash
git rm src/modules/transfers/initiate.test.ts src/modules/transfers/accept-cancel-override.test.ts src/modules/transfers/queries.test.ts
```

- [ ] **Step 7: Write the failing service test (mocked Prisma)**

Create `src/modules/transfers/transfers.service.test.ts`. Follow the mocking style already used in the repo's service tests (mock `@/lib/prisma`). Example:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const item = { id: "itm1", make: "Dell", model: "Latitude", serialNumber: "SN123", status: "ACTIVE" };
const created = { id: "t1", receiptNumber: "HR-AAAA1111" };

vi.mock("@/lib/prisma", () => {
  const tx = {
    item: { findUnique: vi.fn(async () => item) },
    transfer: { create: vi.fn(async () => created), findFirst: vi.fn(), findMany: vi.fn() },
  };
  return {
    default: {
      $transaction: vi.fn(async (fn: any) => fn(tx)),
      transfer: {
        findUnique: vi.fn(),
        findFirst: vi.fn(async () => ({ receiverIsDcsim: false, receiverName: "Prev", receiverRank: "PVT", receiverUnit: "B Co", receiverContact: "x", receiverEmail: "p@u.mil" })),
        findMany: vi.fn(async () => [{ id: "t1", item }]),
      },
    },
    __tx: tx,
  };
});

import prisma from "@/lib/prisma";
import { createTransfer, searchReceipts, getLastReceiver } from "./transfers.service";

const sender = { isDcsim: true, name: "Tech" };
const receiver = { isDcsim: false, name: "Jane", rank: "SGT", unit: "A Co", contact: "808", email: "j@u.mil" };
const sig = "data:image/png;base64,AAAA";

beforeEach(() => vi.clearAllMocks());

describe("createTransfer", () => {
  it("writes snapshot columns and a receipt number, status COMPLETED", async () => {
    await createTransfer({ itemId: "itm1", sender, receiver, receiverSignature: sig });
    const call = (prisma as any).__tx.transfer.create.mock.calls[0][0].data;
    expect(call.senderIsDcsim).toBe(true);
    expect(call.senderName).toBe("Tech");
    expect(call.receiverEmail).toBe("j@u.mil");
    expect(call.receiverSignature).toBe(sig);
    expect(call.status).toBe("COMPLETED");
    expect(call.receiptNumber).toMatch(/^HR-[0-9A-F]{8}$/);
    expect(call.itemSummary).toContain("SN123");
  });
});

describe("searchReceipts", () => {
  it("queries by receiptNumber OR item serial", async () => {
    await searchReceipts("SN123");
    const where = (prisma.transfer.findMany as any).mock.calls[0][0].where;
    expect(JSON.stringify(where)).toContain("serialNumber");
    expect(JSON.stringify(where)).toContain("receiptNumber");
  });
});

describe("getLastReceiver", () => {
  it("maps the last receiver snapshot into a PartyInput", async () => {
    const p = await getLastReceiver("itm1");
    expect(p).toEqual({ isDcsim: false, name: "Prev", rank: "PVT", unit: "B Co", contact: "x", email: "p@u.mil" });
  });
});
```

- [ ] **Step 8: Run test to verify it fails**

Run: `npm test -- transfers.service`
Expected: FAIL — new functions not exported (old service still present).

- [ ] **Step 9: Rewrite `transfers.service.ts`**

Replace the whole file:
```ts
import { Prisma } from "@prisma/client";
import type { Item, Transfer } from "@prisma/client";
import prisma from "@/lib/prisma";
import { generateReceiptNumber } from "./receipt-number";
import { TransferError } from "./transfers.errors";
import type { PartyInput, TransferInput } from "./transfers.schema";

type WithItem = Transfer & { item: Item };

function itemSummary(i: { make: string; model: string; serialNumber: string }): string {
  return `${i.make} ${i.model} (SN ${i.serialNumber})`;
}

export async function createTransfer(
  input: TransferInput & { createdByUserId?: string }
): Promise<Transfer> {
  const { itemId, sender, receiver, receiverSignature, createdByUserId } = input;
  // Retry once on the (astronomically unlikely) receipt-number collision.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        const item = await tx.item.findUnique({ where: { id: itemId } });
        if (!item) throw new TransferError("ITEM_NOT_FOUND");
        if (item.status === "RETIRED") throw new TransferError("ITEM_RETIRED");
        return tx.transfer.create({
          data: {
            receiptNumber: generateReceiptNumber(),
            itemId,
            itemSummary: itemSummary(item),
            senderIsDcsim: sender.isDcsim,
            senderName: sender.name,
            senderRank: sender.rank ?? null,
            senderUnit: sender.unit ?? null,
            senderContact: sender.contact ?? null,
            senderEmail: sender.email ?? null,
            receiverIsDcsim: receiver.isDcsim,
            receiverName: receiver.name,
            receiverRank: receiver.rank ?? null,
            receiverUnit: receiver.unit ?? null,
            receiverContact: receiver.contact ?? null,
            receiverEmail: receiver.email ?? null,
            receiverSignature,
            createdByUserId: createdByUserId ?? null,
            status: "COMPLETED",
          },
        });
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002" && attempt < 2) {
        continue; // duplicate receiptNumber — regenerate
      }
      throw e;
    }
  }
  throw new TransferError("RECEIPT_COLLISION");
}

export function getTransferByReceiptNumber(receiptNumber: string): Promise<WithItem | null> {
  return prisma.transfer.findUnique({
    where: { receiptNumber: receiptNumber.toUpperCase() },
    include: { item: true },
  }) as Promise<WithItem | null>;
}

export function searchReceipts(query: string): Promise<WithItem[]> {
  const q = query.trim();
  if (!q) return Promise.resolve([]);
  return prisma.transfer.findMany({
    where: {
      OR: [
        { receiptNumber: { equals: q.toUpperCase() } },
        { item: { is: { serialNumber: { equals: q, mode: "insensitive" } } } },
      ],
    },
    include: { item: true },
    orderBy: { createdAt: "desc" },
  }) as Promise<WithItem[]>;
}

export async function getLastReceiver(itemId: string): Promise<PartyInput | null> {
  const last = await prisma.transfer.findFirst({
    where: { itemId, status: "COMPLETED" },
    orderBy: { createdAt: "desc" },
  });
  if (!last) return null;
  return {
    isDcsim: last.receiverIsDcsim,
    name: last.receiverName,
    rank: last.receiverRank ?? undefined,
    unit: last.receiverUnit ?? undefined,
    contact: last.receiverContact ?? undefined,
    email: last.receiverEmail ?? undefined,
  };
}

export function getItemHistory(itemId: string): Promise<Transfer[]> {
  return prisma.transfer.findMany({ where: { itemId }, orderBy: { createdAt: "desc" } });
}
```

- [ ] **Step 10: Run test to verify it passes**

Run: `npm test -- transfers.service receipt-number`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add src/modules/transfers/
git commit -m "feat(transfers): kiosk transfer service — create, search, pre-fill; receipt numbers"
```

---

## Task 4: Email sender + receipt-email helper

**Files:**
- Create: `src/lib/email.ts`
- Create: `src/lib/email.test.ts`
- Create: `src/modules/receipts/send-receipt-email.ts`
- Create: `src/modules/receipts/send-receipt-email.test.ts`

**Interfaces:**
- Produces:
  - `EmailMessage { to; subject; text; html? }`, `interface EmailSender { send(msg): Promise<void> }`
  - `getEmailSender(): EmailSender` — Resend when `RESEND_API_KEY` + `EMAIL_FROM` set, else logging stub.
  - `sendReceiptEmails(args: { sender: PartyInput; receiver: PartyInput; receiptNumber: string; receiptUrl: string; itemSummary: string }, deps?: { sender?: EmailSender }): Promise<void>` — emails each non-DCSIM party the receipt link; never throws (logs failures).

- [ ] **Step 1: Write failing email test**

Create `src/lib/email.test.ts`:
```ts
import { describe, it, expect, afterEach } from "vitest";
import { getEmailSender } from "./email";

const orig = { ...process.env };
afterEach(() => { process.env = { ...orig }; });

describe("getEmailSender", () => {
  it("returns the logging stub when Resend env is absent", () => {
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
    expect(getEmailSender().constructor.name).toBe("LogEmailSender");
  });
  it("returns the Resend sender when env is present", () => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.EMAIL_FROM = "receipts@turtolabs.com";
    expect(getEmailSender().constructor.name).toBe("ResendEmailSender");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- lib/email`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `email.ts`**

```ts
export type EmailMessage = { to: string; subject: string; text: string; html?: string };

export interface EmailSender {
  send(msg: EmailMessage): Promise<void>;
}

class LogEmailSender implements EmailSender {
  async send(msg: EmailMessage): Promise<void> {
    console.info(`[email:stub] to=${msg.to} subject=${JSON.stringify(msg.subject)}\n${msg.text}`);
  }
}

class ResendEmailSender implements EmailSender {
  constructor(private apiKey: string, private from: string) {}
  async send(msg: EmailMessage): Promise<void> {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: this.from, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html }),
    });
    if (!res.ok) throw new Error(`Resend send failed: ${res.status} ${await res.text()}`);
  }
}

export function getEmailSender(): EmailSender {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (key && from) return new ResendEmailSender(key, from);
  return new LogEmailSender();
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- lib/email`
Expected: PASS.

- [ ] **Step 5: Write failing receipt-email test**

Create `src/modules/receipts/send-receipt-email.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { sendReceiptEmails } from "./send-receipt-email";

const base = {
  receiptNumber: "HR-AAAA1111",
  receiptUrl: "https://x/receipts/HR-AAAA1111",
  itemSummary: "Dell Latitude (SN SN123)",
};

describe("sendReceiptEmails", () => {
  it("emails only non-DCSIM parties, using their email", async () => {
    const send = vi.fn(async () => {});
    await sendReceiptEmails(
      {
        ...base,
        sender: { isDcsim: true, name: "Tech" },
        receiver: { isDcsim: false, name: "Jane", email: "j@u.mil" },
      },
      { sender: { send } }
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].to).toBe("j@u.mil");
    expect(send.mock.calls[0][0].text).toContain(base.receiptUrl);
  });

  it("never throws when the underlying sender fails", async () => {
    const send = vi.fn(async () => { throw new Error("boom"); });
    await expect(
      sendReceiptEmails(
        { ...base, sender: { isDcsim: false, name: "A", email: "a@u.mil" }, receiver: { isDcsim: false, name: "B", email: "b@u.mil" } },
        { sender: { send } }
      )
    ).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npm test -- send-receipt-email`
Expected: FAIL — module not found.

- [ ] **Step 7: Implement `send-receipt-email.ts`**

```ts
import { getEmailSender, type EmailSender } from "@/lib/email";
import type { PartyInput } from "@/modules/transfers/transfers.schema";

type Args = {
  sender: PartyInput;
  receiver: PartyInput;
  receiptNumber: string;
  receiptUrl: string;
  itemSummary: string;
};

function body(a: Args, party: "sender" | "receiver"): string {
  const role = party === "sender" ? "released" : "received";
  return [
    `A hand receipt (${a.receiptNumber}) recording that you ${role} custody of`,
    `${a.itemSummary} has been generated.`,
    ``,
    `View or download it here: ${a.receiptUrl}`,
  ].join("\n");
}

// Emails each non-DCSIM party their receipt link. Best-effort: a send failure
// is logged and swallowed so it never rolls back the completed transfer.
export async function sendReceiptEmails(args: Args, deps: { sender?: EmailSender } = {}): Promise<void> {
  const sender = deps.sender ?? getEmailSender();
  const targets: Array<{ party: "sender" | "receiver"; email: string }> = [];
  if (!args.sender.isDcsim && args.sender.email) targets.push({ party: "sender", email: args.sender.email });
  if (!args.receiver.isDcsim && args.receiver.email) targets.push({ party: "receiver", email: args.receiver.email });

  await Promise.all(
    targets.map(async (t) => {
      try {
        await sender.send({
          to: t.email,
          subject: `Hand receipt ${args.receiptNumber}`,
          text: body(args, t.party),
        });
      } catch (e) {
        console.error(`[receipt-email] failed to email ${t.email}:`, e);
      }
    })
  );
}
```

- [ ] **Step 8: Run to verify it passes**

Run: `npm test -- send-receipt-email`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/email.ts src/lib/email.test.ts src/modules/receipts/send-receipt-email.ts src/modules/receipts/send-receipt-email.test.ts
git commit -m "feat(email): pluggable EmailSender (Resend/stub) + receipt-link emails"
```

---

## Task 5: QR helpers + PDF rework

**Files:**
- Modify: `src/modules/items/qr.ts`
- Rewrite: `src/modules/receipts/hand-receipt.ts`
- Modify/replace: `src/modules/items/qr.test.ts` (add receipt-url cases)
- Create: `src/modules/receipts/hand-receipt.test.ts`

**Interfaces:**
- Consumes: Prisma `Item`; the transfer snapshot fields.
- Produces:
  - `receiptUrl(receiptNumber, baseUrl?): string`, `receiptQrDataUrl(receiptNumber, baseUrl?): Promise<string>` in `qr.ts`.
  - `buildHandReceiptPdf(t: ReceiptData): Promise<Uint8Array>` with new `ReceiptData` / `ReceiptParty` shape (below).

- [ ] **Step 1: Add receipt-url helpers to `qr.ts`**

Append to `src/modules/items/qr.ts` (keep `itemUrl`/`defaultBaseUrl`):
```ts
export function receiptUrl(receiptNumber: string, baseUrl = defaultBaseUrl()): string {
  return `${baseUrl.replace(/\/$/, "")}/receipts/${receiptNumber}`;
}

export function receiptQrDataUrl(receiptNumber: string, baseUrl?: string): Promise<string> {
  return QRCode.toDataURL(receiptUrl(receiptNumber, baseUrl), { margin: 1, width: 256 });
}
```

- [ ] **Step 2: Add a qr test for the receipt URL**

Add to `src/modules/items/qr.test.ts`:
```ts
import { receiptUrl } from "./qr";
// …
it("builds an absolute receipt URL", () => {
  expect(receiptUrl("HR-AAAA1111", "https://app.example")).toBe("https://app.example/receipts/HR-AAAA1111");
});
```

- [ ] **Step 3: Write the failing PDF test**

Create `src/modules/receipts/hand-receipt.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { buildHandReceiptPdf, type ReceiptData } from "./hand-receipt";

const base: ReceiptData = {
  receiptNumber: "HR-AAAA1111",
  status: "COMPLETED",
  createdAt: new Date("2026-07-02T00:00:00Z"),
  receiptUrl: "https://app.example/receipts/HR-AAAA1111",
  receiverSignature: "",
  item: { make: "Dell", model: "Latitude", serialNumber: "SN123", homeUnit: "A Co" },
  sender: { isDcsim: true, name: "SPC Tech", rank: null, unit: null, contact: null, email: null },
  receiver: { isDcsim: false, name: "Jane Doe", rank: "SGT", unit: "A Co", contact: "808-555", email: "j@u.mil" },
};

describe("buildHandReceiptPdf", () => {
  it("produces a non-empty PDF for a DCSIM-sender receipt", async () => {
    const bytes = await buildHandReceiptPdf(base);
    expect(bytes.length).toBeGreaterThan(1000);
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-");
  });
  it("produces a PDF when the receiver is DCSIM and a signature is present", async () => {
    const bytes = await buildHandReceiptPdf({
      ...base,
      sender: base.receiver,
      receiver: { isDcsim: true, name: "SPC Tech", rank: null, unit: null, contact: null, email: null },
      receiverSignature: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
    });
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-");
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `npm test -- hand-receipt`
Expected: FAIL — new `ReceiptData` shape / `receiptNumber` not present on old module.

- [ ] **Step 5: Rewrite `hand-receipt.ts`**

Keep the DA 2062 fill approach; swap the data shape, print both parties on the record page, and embed the QR. Full replacement:
```ts
import { PDFDocument, StandardFonts, rgb, degrees, TextAlignment } from "pdf-lib";
import QRCode from "qrcode";
import { DA2062_BASE64 } from "./templates/da2062.base64";
import { formatDateHST } from "@/lib/datetime";

export type ReceiptParty = {
  isDcsim: boolean;
  name: string;
  rank: string | null;
  unit: string | null;
  contact: string | null;
  email: string | null;
};

export type ReceiptData = {
  receiptNumber: string;
  status: string;
  createdAt: Date;
  receiptUrl: string;
  receiverSignature: string; // "" or data:image/png;base64,…
  item: { make: string; model: string; serialNumber: string; homeUnit: string | null };
  sender: ReceiptParty;
  receiver: ReceiptParty;
};

const templateBytes = () => Buffer.from(DA2062_BASE64, "base64");

// Header line for FROM/TO: DCSIM shows "DCSIM · <tech name>"; otherwise "<rank> <name>".
function partyHeader(p: ReceiptParty): string {
  if (p.isDcsim) return `DCSIM · ${p.name}`;
  return p.rank ? `${p.rank} ${p.name}` : p.name;
}

// Multi-line block for the custody record page.
function partyBlock(p: ReceiptParty): string[] {
  if (p.isDcsim) return ["DCSIM", `Technician: ${p.name}`];
  return [
    p.rank ? `${p.rank} ${p.name}` : p.name,
    p.unit ? `Unit: ${p.unit}` : "Unit: —",
    p.contact ? `Contact: ${p.contact}` : "Contact: —",
    p.email ? `Email: ${p.email}` : "Email: —",
  ];
}

export async function buildHandReceiptPdf(t: ReceiptData): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(templateBytes());
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const form = pdf.getForm();
  const set = (
    name: string,
    value: string,
    opts: { multiline?: boolean; size?: number; center?: boolean } = {}
  ) => {
    try {
      const field = form.getTextField(name);
      if (opts.multiline) field.enableMultiline();
      if (opts.center) field.setAlignment(TextAlignment.Center);
      field.setFontSize(opts.size ?? 10);
      field.setText(value);
    } catch {
      /* field not present in this template revision — ignore */
    }
  };

  set("FROM", partyHeader(t.sender), { size: 11 });
  set("TO", partyHeader(t.receiver), { size: 11 });
  set("HAND RECEIPT IDENTIFIER", t.receiptNumber, { size: 11 });

  set("ITEM NO aRow1", "1", { size: 9, center: true });
  set("ITEM DESCRIPTION cRow1", `${t.item.make} ${t.item.model}\nSER NO: ${t.item.serialNumber}`, { multiline: true, size: 9 });
  set("UI.0", "EA", { size: 9, center: true });
  set("QTY.0", "1", { size: 9, center: true });

  form.updateFieldAppearances(helv);
  form.flatten();

  // --- Column A: quantity + recipient signature (vertical) + guard bars.
  const page1 = pdf.getPage(0);
  const black = rgb(0, 0, 0);
  const colLeft = 621, colWidth = 23, colCenter = 632, rowTopY = 486, tableBottomY = 58;
  const dateStr = formatDateHST(t.createdAt);

  page1.drawText("1", { x: colCenter - helv.widthOfTextAtSize("1", 9) / 2, y: 492, size: 9, font: helv });

  const sigBottom = 350;
  let blockTop = sigBottom;
  let drewImage = false;
  if (t.receiverSignature && t.receiverSignature.startsWith("data:image/png;base64,")) {
    try {
      const sig = await pdf.embedPng(Buffer.from(t.receiverSignature.split(",")[1], "base64"));
      const barH = 22;
      const barW = Math.min(barH * (sig.width / sig.height), 72);
      page1.drawImage(sig, { x: 642, y: sigBottom, width: barW, height: barH, rotate: degrees(90) });
      const dateY = sigBottom + barW + 10;
      page1.drawText(dateStr, { x: colCenter + 4, y: dateY, size: 9, font: helv, rotate: degrees(90) });
      blockTop = dateY + helv.widthOfTextAtSize(dateStr, 9);
      drewImage = true;
    } catch {
      /* fall through */
    }
  }
  if (!drewImage) {
    const label = `${partyHeader(t.receiver)}   ${dateStr}`;
    page1.drawText(label, { x: colCenter + 4, y: sigBottom, size: 9, font: helv, rotate: degrees(90) });
    blockTop = sigBottom + helv.widthOfTextAtSize(label, 9);
  }
  page1.drawRectangle({ x: colLeft, y: tableBottomY, width: colWidth, height: sigBottom - 4 - tableBottomY, color: black });
  if (rowTopY - (blockTop + 2) > 1) {
    page1.drawRectangle({ x: colLeft, y: blockTop + 2, width: colWidth, height: rowTopY - (blockTop + 2), color: black });
  }

  // --- Custody record page: both parties in full, QR, signature.
  const page = pdf.addPage([612, 792]);
  const ink = rgb(0.06, 0.09, 0.16), muted = rgb(0.4, 0.45, 0.5);
  let y = 730;
  page.drawText("CUSTODY TRANSFER RECORD", { x: 56, y, size: 16, font: bold, color: ink });
  page.drawText(t.receiptNumber, { x: 56, y: y - 18, size: 10, font: helv, color: muted });

  // QR (top-right) linking to the public receipt page.
  try {
    const qrDataUrl = await QRCode.toDataURL(t.receiptUrl, { margin: 1, width: 256 });
    const qr = await pdf.embedPng(Buffer.from(qrDataUrl.split(",")[1], "base64"));
    page.drawImage(qr, { x: 470, y: 690, width: 86, height: 86 });
  } catch {
    /* QR optional — skip on failure */
  }

  y -= 50;
  const meta: [string, string][] = [
    ["Item", `${t.item.make} ${t.item.model}`],
    ["Serial number", t.item.serialNumber],
    ["Home unit", t.item.homeUnit ?? "—"],
    ["Quantity / U/I", "1 EA"],
    ["Date", dateStr],
    ["Status", t.status],
  ];
  for (const [k, v] of meta) {
    page.drawText(k, { x: 56, y, size: 11, font: bold, color: muted });
    page.drawText(v, { x: 200, y, size: 12, font: helv, color: ink });
    y -= 22;
  }

  y -= 16;
  for (const [title, party] of [["FROM (sender)", t.sender], ["TO (recipient)", t.receiver]] as const) {
    page.drawText(title, { x: 56, y, size: 11, font: bold, color: muted });
    y -= 16;
    for (const line of partyBlock(party)) {
      page.drawText(line, { x: 66, y, size: 11, font: helv, color: ink });
      y -= 15;
    }
    y -= 10;
  }

  y -= 6;
  page.drawText("Recipient signature", { x: 56, y, size: 11, font: bold, color: muted });
  y -= 14;
  if (t.receiverSignature && t.receiverSignature.startsWith("data:image/png;base64,")) {
    try {
      const png = await pdf.embedPng(Buffer.from(t.receiverSignature.split(",")[1], "base64"));
      const w = 260, h = Math.min((png.height / png.width) * w, 110);
      page.drawImage(png, { x: 56, y: y - h, width: w, height: h });
      y -= h;
    } catch {
      page.drawText("(signature on file)", { x: 56, y: y - 12, size: 11, font: helv, color: muted });
      y -= 24;
    }
  } else {
    page.drawText("(no signature captured)", { x: 56, y: y - 12, size: 11, font: helv, color: muted });
    y -= 24;
  }
  page.drawLine({ start: { x: 56, y: y - 10 }, end: { x: 320, y: y - 10 }, thickness: 0.5, color: muted });
  page.drawText(`${partyHeader(t.receiver)} · ${dateStr}`, { x: 56, y: y - 24, size: 10, font: helv, color: muted });

  return pdf.save();
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- hand-receipt qr`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/modules/items/qr.ts src/modules/items/qr.test.ts src/modules/receipts/hand-receipt.ts src/modules/receipts/hand-receipt.test.ts
git commit -m "feat(receipts): two-party DA 2062 + QR; receipt-url helpers"
```

---

## Task 6: Public receipt PDF route, receipt page, and search page

**Files:**
- Create: `src/app/receipts/[receiptNumber]/pdf/route.ts`
- Create: `src/app/receipts/[receiptNumber]/page.tsx`
- Create: `src/app/actions/receipts.ts`
- Create: `src/components/ReceiptSearch.tsx`
- Rewrite: `src/app/page.tsx`

**Interfaces:**
- Consumes: `getTransferByReceiptNumber`, `searchReceipts` (Task 3); `buildHandReceiptPdf`, `receiptUrl` (Task 5).
- Produces: public route `GET /receipts/[receiptNumber]/pdf`; `searchReceiptsAction(_prev, formData)` returning `{ results }` / `{ error }`.

- [ ] **Step 1: Build the public PDF route (maps a transfer → ReceiptData)**

Create `src/app/receipts/[receiptNumber]/pdf/route.ts`:
```ts
import { getTransferByReceiptNumber } from "@/modules/transfers/transfers.service";
import { buildHandReceiptPdf, type ReceiptParty } from "@/modules/receipts/hand-receipt";
import { receiptUrl } from "@/modules/items/qr";

export async function GET(_req: Request, { params }: { params: Promise<{ receiptNumber: string }> }) {
  const { receiptNumber } = await params;
  const t = await getTransferByReceiptNumber(receiptNumber);
  if (!t) return new Response("Not found", { status: 404 });

  const sender: ReceiptParty = {
    isDcsim: t.senderIsDcsim, name: t.senderName, rank: t.senderRank, unit: t.senderUnit, contact: t.senderContact, email: t.senderEmail,
  };
  const receiver: ReceiptParty = {
    isDcsim: t.receiverIsDcsim, name: t.receiverName, rank: t.receiverRank, unit: t.receiverUnit, contact: t.receiverContact, email: t.receiverEmail,
  };

  const bytes = await buildHandReceiptPdf({
    receiptNumber: t.receiptNumber,
    status: t.status,
    createdAt: t.createdAt,
    receiptUrl: receiptUrl(t.receiptNumber),
    receiverSignature: t.receiverSignature,
    item: { make: t.item.make, model: t.item.model, serialNumber: t.item.serialNumber, homeUnit: t.item.homeUnit },
    sender,
    receiver,
  });

  return new Response(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="hand-receipt-${t.receiptNumber}.pdf"`,
    },
  });
}
```

- [ ] **Step 2: Build the public receipt page**

Create `src/app/receipts/[receiptNumber]/page.tsx`:
```tsx
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTransferByReceiptNumber } from "@/modules/transfers/transfers.service";
import { formatDateTimeHST } from "@/lib/datetime";

function partyLine(p: { isDcsim: boolean; name: string; rank: string | null; unit: string | null }): string {
  if (p.isDcsim) return `DCSIM · ${p.name}`;
  const head = p.rank ? `${p.rank} ${p.name}` : p.name;
  return p.unit ? `${head} (${p.unit})` : head;
}

export default async function ReceiptPage({ params }: { params: Promise<{ receiptNumber: string }> }) {
  const { receiptNumber } = await params;
  const t = await getTransferByReceiptNumber(receiptNumber);
  if (!t) notFound();

  return (
    <main className="container container-mid stack">
      <h1 className="page-title">Hand receipt {t.receiptNumber}</h1>
      <div className="card stack-sm">
        <div><strong>Item:</strong> {t.item.make} {t.item.model} (SN {t.item.serialNumber})</div>
        <div><strong>From:</strong> {partyLine({ isDcsim: t.senderIsDcsim, name: t.senderName, rank: t.senderRank, unit: t.senderUnit })}</div>
        <div><strong>To:</strong> {partyLine({ isDcsim: t.receiverIsDcsim, name: t.receiverName, rank: t.receiverRank, unit: t.receiverUnit })}</div>
        <div><strong>Date:</strong> {formatDateTimeHST(t.createdAt)}</div>
      </div>
      <div className="row">
        <a className="btn btn-primary" href={`/receipts/${t.receiptNumber}/pdf`}>Download PDF</a>
        <Link className="btn btn-ghost" href="/">Search another</Link>
      </div>
    </main>
  );
}
```

- [ ] **Step 3: Build the search action**

Create `src/app/actions/receipts.ts`:
```ts
"use server";
import { searchReceipts } from "@/modules/transfers/transfers.service";

export type ReceiptResult = {
  receiptNumber: string;
  itemSummary: string;
  fromLabel: string;
  toLabel: string;
};

function label(isDcsim: boolean, name: string, rank: string | null): string {
  if (isDcsim) return `DCSIM · ${name}`;
  return rank ? `${rank} ${name}` : name;
}

export async function searchReceiptsAction(_prev: unknown, formData: FormData) {
  const query = String(formData.get("query") ?? "").trim();
  if (!query) return { error: "Enter a serial number or receipt number." };
  const rows = await searchReceipts(query);
  const results: ReceiptResult[] = rows.map((t) => ({
    receiptNumber: t.receiptNumber,
    itemSummary: t.itemSummary,
    fromLabel: label(t.senderIsDcsim, t.senderName, t.senderRank),
    toLabel: label(t.receiverIsDcsim, t.receiverName, t.receiverRank),
  }));
  return { results };
}
```

- [ ] **Step 4: Build the search component**

Create `src/components/ReceiptSearch.tsx`:
```tsx
"use client";
import { useActionState } from "react";
import { searchReceiptsAction, type ReceiptResult } from "@/app/actions/receipts";

export function ReceiptSearch() {
  const [state, action, pending] = useActionState(searchReceiptsAction, undefined);
  const results: ReceiptResult[] | undefined = state && "results" in state ? state.results : undefined;
  return (
    <div className="stack">
      <form action={action} className="row">
        <input className="input" name="query" placeholder="Serial number or HR-XXXXXXXX" required aria-label="Search" />
        <button className="btn btn-primary" disabled={pending} type="submit">{pending ? "Searching…" : "Search"}</button>
      </form>
      {state && "error" in state && state.error && <p role="alert" className="alert-error">{state.error}</p>}
      {results && results.length === 0 && <p className="subtle">No receipts found.</p>}
      {results && results.length > 0 && (
        <ul className="stack-sm">
          {results.map((r) => (
            <li key={r.receiptNumber} className="card row">
              <div>
                <div><strong>{r.receiptNumber}</strong> — {r.itemSummary}</div>
                <div className="subtle">{r.fromLabel} → {r.toLabel}</div>
              </div>
              <span className="spacer" />
              <a className="btn btn-secondary btn-sm" href={`/receipts/${r.receiptNumber}/pdf`}>Download PDF</a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Rewrite the home page as the public search**

Replace `src/app/page.tsx`:
```tsx
import Link from "next/link";
import { ReceiptSearch } from "@/components/ReceiptSearch";

export default function HomePage() {
  return (
    <>
      <header className="app-header">
        <div className="app-header__inner">
          <Link href="/" className="brand"><span className="brand__mark">HR</span>Hand Receipt</Link>
          <span className="spacer" />
          <Link href="/login" className="btn btn-ghost btn-sm">Staff sign in</Link>
        </div>
      </header>
      <main className="container container-mid stack">
        <div>
          <h1 className="page-title">Find your hand receipt</h1>
          <p className="subtle">Search by item serial number or receipt number (HR-XXXXXXXX) to view and download your receipt.</p>
        </div>
        <ReceiptSearch />
      </main>
    </>
  );
}
```

- [ ] **Step 6: Verify build + a route smoke check**

Run: `npx tsc --noEmit` (expect remaining errors only in files still to be handled in Tasks 7–8), then once Tasks 7–8 are done, `npm run build`.
Manual smoke (after DB has a receipt): visit `/receipts/HR-…` and `/receipts/HR-…/pdf`; unknown number → 404.

- [ ] **Step 7: Commit**

```bash
git add src/app/receipts src/app/actions/receipts.ts src/components/ReceiptSearch.tsx src/app/page.tsx
git commit -m "feat(public): receipt search, public receipt page + PDF download"
```

---

## Task 7: Kiosk transfer flow (`/new`) — action, page, form

**Files:**
- Rewrite: `src/app/actions/transfers.ts`
- Create: `src/app/actions/transfers.parse.ts` (pure FormData → TransferInput mapper, unit-testable)
- Create: `src/app/actions/transfers.parse.test.ts`
- Create: `src/app/new/page.tsx`
- Create: `src/app/new/NewTransferForm.tsx`
- Modify: `src/app/admin/actions/items.ts` (export a non-admin `logItem` path used by the flow) — or add `logItemForTransfer` in the transfer action directly (chosen below).

**Interfaces:**
- Consumes: `transferSchema`, `PartyInput` (Task 2); `createTransfer`, `getLastReceiver` (Task 3); `sendReceiptEmails` (Task 4); `receiptUrl` (Task 5); `createItem` (items.service); `requireUser` (authz).
- Produces: `parseTransferForm(formData): { itemMode: "existing" | "new"; itemId?: string; newItem?: NewItemInput; sender: PartyInput; receiver: PartyInput; receiverSignature: string }`; `createTransferAction(_prev, formData)` returning `{ receiptNumber }` / `{ error }`; `lookupLastHolderAction(itemId): Promise<PartyInput | null>` (auth-gated; imperatively called from the form to pre-fill the sender).

- [ ] **Step 1: Write the failing parser test**

Create `src/app/actions/transfers.parse.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parseTransferForm } from "./transfers.parse";

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

describe("parseTransferForm", () => {
  it("reads an existing-item transfer with a DCSIM sender", () => {
    const out = parseTransferForm(fd({
      itemMode: "existing", itemId: "itm1",
      senderIsDcsim: "on", senderName: "Tech",
      receiverIsDcsim: "", receiverName: "Jane", receiverRank: "SGT", receiverUnit: "A Co", receiverContact: "808", receiverEmail: "j@u.mil",
      receiverSignature: "data:image/png;base64,AAAA",
    }));
    expect(out.itemMode).toBe("existing");
    expect(out.itemId).toBe("itm1");
    expect(out.sender.isDcsim).toBe(true);
    expect(out.receiver.isDcsim).toBe(false);
    expect(out.receiver.email).toBe("j@u.mil");
  });
  it("reads a new-item transfer", () => {
    const out = parseTransferForm(fd({
      itemMode: "new", make: "Dell", model: "Latitude", serialNumber: "SN1", homeUnit: "A Co",
      senderIsDcsim: "", senderName: "A", senderRank: "PVT", senderUnit: "A", senderContact: "1", senderEmail: "a@u.mil",
      receiverIsDcsim: "on", receiverName: "Tech",
      receiverSignature: "data:image/png;base64,BBBB",
    }));
    expect(out.itemMode).toBe("new");
    expect(out.newItem?.make).toBe("Dell");
    expect(out.receiver.isDcsim).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- transfers.parse`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the parser**

Create `src/app/actions/transfers.parse.ts`:
```ts
import type { NewItemInput } from "@/modules/items/items.schema";

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const bool = (fd: FormData, k: string) => {
  const v = s(fd, k);
  return v === "on" || v === "true";
};

function party(fd: FormData, prefix: "sender" | "receiver") {
  return {
    isDcsim: bool(fd, `${prefix}IsDcsim`),
    name: s(fd, `${prefix}Name`),
    rank: s(fd, `${prefix}Rank`) || undefined,
    unit: s(fd, `${prefix}Unit`) || undefined,
    contact: s(fd, `${prefix}Contact`) || undefined,
    email: s(fd, `${prefix}Email`) || undefined,
  };
}

export function parseTransferForm(fd: FormData) {
  const itemMode = s(fd, "itemMode") === "new" ? "new" : "existing";
  const newItem: NewItemInput | undefined =
    itemMode === "new"
      ? { make: s(fd, "make"), model: s(fd, "model"), serialNumber: s(fd, "serialNumber"), homeUnit: s(fd, "homeUnit") || undefined, notes: s(fd, "notes") || undefined }
      : undefined;
  return {
    itemMode,
    itemId: itemMode === "existing" ? s(fd, "itemId") : undefined,
    newItem,
    sender: party(fd, "sender"),
    receiver: party(fd, "receiver"),
    receiverSignature: String(fd.get("receiverSignature") ?? ""),
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- transfers.parse`
Expected: PASS.

- [ ] **Step 5: Rewrite the transfer action**

Replace `src/app/actions/transfers.ts`:
```ts
"use server";
import { requireUser } from "@/lib/authz";
import { createItem } from "@/modules/items/items.service";
import { newItemSchema } from "@/modules/items/items.schema";
import { createTransfer, getLastReceiver } from "@/modules/transfers/transfers.service";
import { transferSchema } from "@/modules/transfers/transfers.schema";
import { TransferError } from "@/modules/transfers/transfers.errors";
import { sendReceiptEmails } from "@/modules/receipts/send-receipt-email";
import { receiptUrl } from "@/modules/items/qr";
import { parseTransferForm } from "./transfers.parse";

export async function createTransferAction(_prev: unknown, formData: FormData) {
  const user = await requireUser();
  const raw = parseTransferForm(formData);

  // Resolve the item first (creating it when in "new" mode).
  let itemId = raw.itemId ?? "";
  if (raw.itemMode === "new") {
    const parsedItem = newItemSchema.safeParse(raw.newItem);
    if (!parsedItem.success) return { error: parsedItem.error.issues[0]?.message ?? "Invalid item" };
    const item = await createItem(parsedItem.data, user.id);
    itemId = item.id;
  }

  const parsed = transferSchema.safeParse({
    itemId,
    sender: raw.sender,
    receiver: raw.receiver,
    receiverSignature: raw.receiverSignature,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  let receiptNumber: string;
  try {
    const t = await createTransfer({ ...parsed.data, createdByUserId: user.id });
    receiptNumber = t.receiptNumber;
    await sendReceiptEmails({
      sender: parsed.data.sender,
      receiver: parsed.data.receiver,
      receiptNumber: t.receiptNumber,
      receiptUrl: receiptUrl(t.receiptNumber),
      itemSummary: t.itemSummary,
    });
  } catch (e) {
    if (e instanceof TransferError) {
      const map: Record<string, string> = {
        ITEM_NOT_FOUND: "That item no longer exists.",
        ITEM_RETIRED: "That item is retired and cannot be transferred.",
        RECEIPT_COLLISION: "Could not allocate a receipt number — please retry.",
      };
      return { error: map[e.code] ?? "Could not create the receipt." };
    }
    throw e;
  }
  return { receiptNumber };
}

// Imperatively invoked by the /new form when an existing item is selected, to
// pre-fill the sender from the item's last-known holder. Auth-gated.
export async function lookupLastHolderAction(itemId: string) {
  await requireUser();
  if (!itemId) return null;
  return getLastReceiver(itemId);
}
```

- [ ] **Step 6: Build the `/new` page (server component)**

Create `src/app/new/page.tsx`:
```tsx
import Link from "next/link";
import { requireUser } from "@/lib/authz";
import { listItems } from "@/modules/items/items.service";
import { NewTransferForm } from "./NewTransferForm";

export default async function NewTransferPage() {
  const user = await requireUser();
  const items = await listItems();
  const itemOptions = items.map((i) => ({ id: i.id, label: `${i.make} ${i.model} (SN ${i.serialNumber})` }));
  const me = {
    rank: user.name ? "" : "", // rank/unit/contact are on the DB user; see note below
  };
  return (
    <>
      <header className="app-header">
        <div className="app-header__inner">
          <Link href="/" className="brand"><span className="brand__mark">HR</span>Hand Receipt</Link>
          <span className="spacer" />
          <span className="subtle">{user.name}</span>
        </div>
      </header>
      <main className="container container-mid stack">
        <h1 className="page-title">New hand receipt</h1>
        <NewTransferForm items={itemOptions} operatorName={user.name} />
      </main>
    </>
  );
}
```
> Note: `SessionUser` only carries `id/role/name/email`. Pre-filling the logged-in regular user's rank/unit/contact/email requires reading the full `User` row. Add a small read: `const dbUser = await prisma.user.findUnique({ where: { id: user.id }, select: { rank: true, name: true, unit: true, contactNumber: true, email: true, role: true } });` and pass `operator={{ rank: dbUser?.rank ?? "", name: dbUser?.name ?? user.name, unit: dbUser?.unit ?? "", contact: dbUser?.contactNumber ?? "", email: dbUser?.email ?? user.email, isAdmin: dbUser?.role === "ADMIN" }}` to the form. Replace the `me`/`operatorName` placeholders accordingly (import `prisma` from `@/lib/prisma`).

- [ ] **Step 7: Build the `/new` form (client component)**

Create `src/app/new/NewTransferForm.tsx`. It has: item selector with an "existing / new" toggle; two `PartyFields` fieldsets (sender/receiver) each with a "This side is DCSIM" checkbox that hides the extra fields; the `SignaturePad`; on success shows the receipt number + links. Regular (non-admin) operators default to being the **sender** and can pre-fill that side from their account.
```tsx
"use client";
import { useActionState, useState } from "react";
import { createTransferAction, lookupLastHolderAction } from "@/app/actions/transfers";
import { SignaturePad } from "@/components/SignaturePad";

type Operator = { rank: string; name: string; unit: string; contact: string; email: string; isAdmin: boolean };
type ItemOption = { id: string; label: string };
type Prefill = Partial<Operator> & { isDcsim?: boolean };

function PartyFields({ role, prefill }: { role: "sender" | "receiver"; prefill?: Prefill }) {
  const [isDcsim, setIsDcsim] = useState(prefill?.isDcsim ?? false);
  const cap = role === "sender" ? "Sender" : "Recipient";
  return (
    <fieldset className="card stack-sm">
      <legend className="card__title">{cap}</legend>
      <label className="row">
        <input type="checkbox" name={`${role}IsDcsim`} checked={isDcsim} onChange={(e) => setIsDcsim(e.target.checked)} />
        This side is DCSIM
      </label>
      <div className="field">
        <label className="label">{isDcsim ? "DCSIM technician name" : "Name"}</label>
        <input className="input" name={`${role}Name`} defaultValue={prefill?.name ?? ""} required />
      </div>
      {!isDcsim && (
        <div className="form-grid">
          <div className="field"><label className="label">Rank</label><input className="input" name={`${role}Rank`} defaultValue={prefill?.rank ?? ""} required /></div>
          <div className="field"><label className="label">Unit</label><input className="input" name={`${role}Unit`} defaultValue={prefill?.unit ?? ""} required /></div>
          <div className="field"><label className="label">Contact number</label><input className="input" name={`${role}Contact`} defaultValue={prefill?.contact ?? ""} required /></div>
          <div className="field"><label className="label">Email</label><input className="input" type="email" name={`${role}Email`} defaultValue={prefill?.email ?? ""} required /></div>
        </div>
      )}
    </fieldset>
  );
}

export function NewTransferForm({ items, operator }: { items: ItemOption[]; operator: Operator }) {
  const [state, action, pending] = useActionState(createTransferAction, undefined);
  const [itemMode, setItemMode] = useState<"existing" | "new">(items.length ? "existing" : "new");
  const receipt = state && "receiptNumber" in state ? state.receiptNumber : undefined;

  // Sender pre-fill precedence: item's last-known holder (fetched on select) >
  // the logged-in non-admin operator's own account > empty. The sender fieldset
  // is remounted via `senderKey` so its uncontrolled inputs re-apply defaults.
  const [senderPrefill, setSenderPrefill] = useState<Prefill | undefined>(operator.isAdmin ? undefined : operator);
  const [senderKey, setSenderKey] = useState(0);

  async function onItemSelected(itemId: string) {
    if (!itemId) return;
    const last = await lookupLastHolderAction(itemId);
    if (last) {
      setSenderPrefill(
        last.isDcsim
          ? { isDcsim: true, name: last.name }
          : { isDcsim: false, name: last.name, rank: last.rank ?? "", unit: last.unit ?? "", contact: last.contact ?? "", email: last.email ?? "" }
      );
    } else {
      setSenderPrefill(operator.isAdmin ? undefined : operator);
    }
    setSenderKey((k) => k + 1);
  }

  if (receipt) {
    return (
      <div className="card stack-sm">
        <h2 className="page-title">Receipt {receipt} created</h2>
        <div className="row">
          <a className="btn btn-primary" href={`/receipts/${receipt}/pdf`}>Download PDF</a>
          <a className="btn btn-secondary" href={`/receipts/${receipt}`}>View receipt</a>
          <a className="btn btn-ghost" href="/new">New transfer</a>
        </div>
      </div>
    );
  }

  return (
    <form action={action} className="stack">
      <fieldset className="card stack-sm">
        <legend className="card__title">Item</legend>
        <div className="row">
          <label className="row"><input type="radio" name="itemMode" value="existing" checked={itemMode === "existing"} onChange={() => setItemMode("existing")} /> Existing</label>
          <label className="row"><input type="radio" name="itemMode" value="new" checked={itemMode === "new"} onChange={() => setItemMode("new")} /> Log new item</label>
        </div>
        {itemMode === "existing" ? (
          <select className="select" name="itemId" defaultValue="" required onChange={(e) => onItemSelected(e.target.value)}>
            <option value="" disabled>Select an item…</option>
            {items.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}
          </select>
        ) : (
          <div className="form-grid">
            <div className="field"><label className="label">Make</label><input className="input" name="make" required /></div>
            <div className="field"><label className="label">Model</label><input className="input" name="model" required /></div>
            <div className="field"><label className="label">Serial number</label><input className="input" name="serialNumber" required /></div>
            <div className="field"><label className="label">Home unit</label><input className="input" name="homeUnit" /></div>
            <div className="field"><label className="label">Notes (optional)</label><input className="input" name="notes" /></div>
          </div>
        )}
      </fieldset>

      <PartyFields key={senderKey} role="sender" prefill={senderPrefill} />
      <PartyFields role="receiver" />

      <fieldset className="card stack-sm">
        <legend className="card__title">Recipient signature</legend>
        <SignaturePad name="receiverSignature" />
      </fieldset>

      <div className="row">
        <button className="btn btn-primary" disabled={pending} type="submit">{pending ? "Creating…" : "Create hand receipt"}</button>
        {state && "error" in state && state.error && <span role="alert" className="alert-error">{state.error}</span>}
      </div>
    </form>
  );
}
```
> Update `page.tsx` (Step 6) to pass `operator={…}` (per the note) instead of `operatorName`.

- [ ] **Step 8: Type-check the flow**

Run: `npx tsc --noEmit`
Expected: errors now only in leftover files handled by Task 8 (`/i`, `/dashboard`, `/transfers/[id]`, `InitiateTransferForm`, `OverrideForm`, admin override action, register).

- [ ] **Step 9: Commit**

```bash
git add src/app/new src/app/actions/transfers.ts src/app/actions/transfers.parse.ts src/app/actions/transfers.parse.test.ts
git commit -m "feat(kiosk): single-device /new transfer flow with two-party entry + signature"
```

---

## Task 8: Remove old flows, wire auth, update admin + users

**Files:**
- Delete: `src/app/register/`, `src/app/dashboard/`, `src/app/i/`, `src/app/transfers/[id]/` (incl. `SignForm.tsx` and old `receipt/route.ts`), `src/components/InitiateTransferForm.tsx`, `src/components/OverrideForm.tsx`, `src/app/admin/actions/override.ts`
- Modify: `src/app/actions/auth.ts` (drop `registerAction`), `src/modules/users/users.service.ts` (drop `registerUser`, persist `unit`/`contactNumber`), `src/modules/users/users.schema.ts` (drop `registerSchema` — done in Task 2? keep until now), `src/app/admin/actions/users.ts` (unchanged logic, verify), `src/app/admin/users/NewUserForm.tsx` (add unit/contact inputs)
- Modify: `src/proxy.ts` (public matcher), `src/app/admin/actions/items.ts` (drop initial-holder), admin item pages/forms (reduced fields), `src/app/login/page.tsx` (remove "create account" link if present)

**Interfaces:**
- Consumes: everything from prior tasks.
- Produces: `createUser` persisting `unit`/`contactNumber`; public routes `/`, `/login`, `/receipts/*`.

- [ ] **Step 1: Delete obsolete routes/components**

```bash
git rm -r src/app/register src/app/dashboard src/app/i src/app/transfers src/components/InitiateTransferForm.tsx src/components/OverrideForm.tsx src/app/admin/actions/override.ts
```

- [ ] **Step 2: Drop self-registration from auth + users**

Edit `src/app/actions/auth.ts` — remove `registerAction` and its imports (`registerUser`, `registerSchema`, `AuthError` if now unused keep for login). Keep `loginAction` (already redirects to `/`) and `logoutAction`.

Edit `src/modules/users/users.service.ts` — delete `registerUser`; update `createUser` to persist the new fields:
```ts
export async function createUser(input: NewUserInput): Promise<User> {
  const data = newUserSchema.parse(input);
  return prisma.user.create({
    data: {
      rank: data.rank,
      name: data.name,
      email: data.email,
      unit: data.unit,
      contactNumber: data.contactNumber,
      role: data.role,
      passwordHash: await hashPassword(data.password),
    },
  });
}
```
Edit `src/modules/users/users.schema.ts` — remove `registerSchema`/`RegisterInput` exports.

- [ ] **Step 3: Update the failing users service test**

In `src/modules/users/users.service.test.ts`, remove `registerUser` cases and add an assertion that `createUser` forwards `unit`/`contactNumber` to `prisma.user.create`. Run: `npm test -- users.service` → PASS.

- [ ] **Step 4: Add unit/contact inputs to `NewUserForm.tsx`**

Inside the `.form-grid`, after the email field, add:
```tsx
<div className="field">
  <label className="label" htmlFor="nu-unit">Unit</label>
  <input id="nu-unit" className="input" name="unit" placeholder="e.g. A Co, 1-1 IN (optional)" />
</div>
<div className="field">
  <label className="label" htmlFor="nu-contact">Contact number</label>
  <input id="nu-contact" className="input" name="contactNumber" placeholder="(optional)" />
</div>
```

- [ ] **Step 5: Reduce admin item create/update + drop initial holder**

Edit `src/app/admin/actions/items.ts`:
- Remove the `assignInitialHolder` import and the `initialHolderId` block from `createItemAction`.
- Change `revalidatePath(\`/i/${id}\`)` calls to `revalidatePath("/admin/items")` only (the `/i` route is gone).

Update the admin item forms/pages (`src/app/admin/items/new/NewItemForm.tsx`, `.../[itemId]/edit/EditItemForm.tsx`, `src/components/ItemDetails.tsx`, `src/app/admin/items/page.tsx`) to drop `assetTag`, rename `homeLocation`→`homeUnit`, and remove any holder/initial-holder UI and `listItems`' `assetTag` search term. Also update `items.service.ts` `listItems` to drop the `assetTag` OR-clause and `getItem`'s `currentHolder` include (no longer exists):
```ts
export function getItem(id: string) {
  return prisma.item.findUnique({ where: { id } });
}
export function listItems(opts: { search?: string } = {}) {
  const search = opts.search?.trim();
  return prisma.item.findMany({
    where: search
      ? { OR: [
          { make: { contains: search, mode: "insensitive" } },
          { model: { contains: search, mode: "insensitive" } },
          { serialNumber: { contains: search, mode: "insensitive" } },
        ] }
      : undefined,
    orderBy: { createdAt: "desc" },
  });
}
```
Fix `ItemWithHolder`/`items.service.test.ts` references to removed fields.

- [ ] **Step 6: Update `proxy.ts` matcher for the new public surface**

Replace the matcher so `/`, `/login`, `/receipts/*`, and auth API are public; everything else (incl. `/new`, `/admin`) is authed:
```ts
export { auth as proxy } from "@/auth";

export const config = {
  // Public: home (search), login, receipt pages, auth API, static assets.
  matcher: ["/((?!api/auth|login|receipts/|_next/static|_next/image|favicon.ico|$).*)"],
};
```
> Verify against `node_modules/next/dist/docs` that `$` end-anchor excludes the bare `/` route; if the negative-lookahead syntax differs in Next 16, gate `/` inside the page instead (the home page has no auth calls, so a matcher miss is harmless).

- [ ] **Step 7: Remove the "create account" link on the login page (if present)**

Open `src/app/login/page.tsx`; delete any link to `/register`.

- [ ] **Step 8: Full type-check, lint, tests, build**

Run:
```bash
npx tsc --noEmit
npm run lint
npm test
npm run build
```
Expected: all green. Fix any dangling imports to deleted modules (search for `assignInitialHolder`, `overrideAssign`, `acceptTransfer`, `initiateTransfer`, `registerUser`, `assetTag`, `homeLocation`, `currentHolder`).

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor: remove two-device flows + self-registration; reduce items; wire public auth"
```

---

## Task 9: Env, docs, and final verification

**Files:**
- Modify: `.env.example` (create if absent)
- Modify: `docs/ARCHITECTURE.md` (brief update), `README` if present

- [ ] **Step 1: Document new env vars**

Add to `.env.example`:
```
# Transactional email (optional in dev — without these, receipt links are logged, not sent)
RESEND_API_KEY=
EMAIL_FROM="Hand Receipt <receipts@turtolabs.com>"
# Absolute base URL used in QR codes + emailed links (falls back to Vercel envs)
APP_URL=
```

- [ ] **Step 2: Update architecture doc**

In `docs/ARCHITECTURE.md`, replace the transfer-flow section with a short description of the kiosk model (typed party snapshots on `Transfer`, recipient-only signature, public receipt search + PDF, Resend email). Keep it to a few paragraphs.

- [ ] **Step 3: Final full verification**

Run:
```bash
npm test
npm run build
```
Expected: all tests pass; production build succeeds.

- [ ] **Step 4: Manual E2E smoke (documented, run against a dev DB)**

1. Sign in as admin → `/new` → log a new item, DCSIM sender, non-DCSIM receiver, sign → receipt created.
2. Copy the `HR-…` → open `/` (in a private window, no login) → search by that number and by the serial → Download PDF works.
3. Confirm the PDF shows both parties, the recipient signature, and a scannable QR to `/receipts/HR-…`.
4. Without `RESEND_API_KEY`, confirm the server log shows the `[email:stub]` line with the receipt URL.

- [ ] **Step 5: Commit**

```bash
git add .env.example docs/ARCHITECTURE.md
git commit -m "docs: env + architecture updates for kiosk hand-receipt model"
```

---

## Self-Review Notes (coverage map)

- **Single-device flow, select item + both parties** → Task 7 (`/new`, form + action).
- **Mark either side DCSIM; DCSIM tech always names, signs only when recipient** → party schema (Task 2), form toggle (Task 7), recipient-only `SignaturePad` (Task 7), PDF header/blocks (Task 5).
- **Non-DCSIM party rank/name/unit/contact required + on receipt** → party schema (Task 2), PDF `partyBlock` (Task 5).
- **Non-DCSIM party email + emailed link = QR link** → `sendReceiptEmails` (Task 4), `receiptUrl` shared by QR + email (Tasks 5, 7).
- **New item = make/model/serial/homeUnit/notes only** → schema (Task 2), migration (Task 1), forms (Tasks 7–8).
- **Remove account self-creation** → Task 8.
- **Public search by serial/receipt number + PDF download** → Task 6.
- **Migration keep-admin-wipe-rest** → Task 1.
- **Pre-fill sender from last holder** → `getLastReceiver` (Task 3) + `lookupLastHolderAction` + dynamic sender pre-fill on item select (Task 7). Precedence: last-known holder > logged-in non-admin operator's account > empty.
```
