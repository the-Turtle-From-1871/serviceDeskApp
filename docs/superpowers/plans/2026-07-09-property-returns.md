# Property Returns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a service-desk admin process partial and full equipment returns against a hand receipt — checking off returned serial numbers, computing new balances, writing an immutable ledger, closing the receipt when empty, and emailing the customer.

**Architecture:** A pure `planReturn` decides PARTIAL vs FULL from the checked serials; `processReturn` applies it in one transaction (stamp `TransferItem.returnedAt`, close the `Transfer` on a full return, write a `ReturnTransaction` ledger row). A `/receipts/[receiptNumber]/return` admin page drives it; the public receipt page renders redline balances and a VOID/CLEARED state; the on-demand PDF gains a VOID/CLEARED overlay when closed; email notifies the customer (CC the service desk).

**Tech Stack:** Next.js 16 App Router (React 19 Server Components + Server Actions), Prisma 7 + `@prisma/adapter-pg` (PostgreSQL/Supabase), Auth.js v5, Resend, `pdf-lib`, Vitest.

## Global Constraints

- **Status enum values are exactly `OPEN | CLOSED`** (replacing the current `COMPLETED | VOID`). `ReturnKind` values are exactly `PARTIAL | FULL`.
- **Auth-first:** every Server Action and admin page checks auth before any work. Use `requireAdmin`/`requireUser` from `@/lib/authz`; catch `AuthError`. `SessionUser = { id, role, name, email }`.
- **Returns are admin-only.** The return page and `processReturnAction` both call `requireAdmin()`.
- **Injection/XSS:** Prisma methods only (no raw string interpolation). No `dangerouslySetInnerHTML`.
- **Error handling:** catch exceptions in actions; return a generic client message (`"Something went wrong…"`) and `console.error` the detail server-side.
- **Email is best-effort:** a send failure is caught, logged, and swallowed — it never rolls back a committed return.
- **Immutable history:** `ReturnTransaction` rows and `TransferItem.returnedAt` are write-once; there is no undo/edit path. Over-return is impossible (only currently-held serials are selectable/accepted).
- **Exact email subjects:**
  - Partial: `UPDATE: G6 Digital Hand Receipt - Partial Property Return Confirmation [ID: <receiptNumber>]`
  - Full: `CLEARANCE RECORD: G6 Digital Hand Receipt - Final Property Return [ID: <receiptNumber>]`
- **Exact serial-verification checkbox copy:** `I have physically verified that the serial number on the device matches the screen`
- **Exact env var name:** `G6_SERVICE_DESK_EMAIL` (the desk CC address; when unset, no CC is added).
- **Deploy rule:** apply the migration to Supabase (`prisma migrate deploy` against the prod `DATABASE_URL`) **before** pushing. Keep the commit-author email that Vercel Hobby requires (do not change git identity).
- **Tests:** real-DB tests import `migrateTestDb`/`resetDb` from `tests/helpers/db` (they target `handreceipt_test`); pure-module tests are plain Vitest. Dates render via `formatDateHST`/`formatDateTimeHST` from `@/lib/datetime`.

---

### Task 1: Data model, migration, and status wiring

**Files:**
- Modify: `prisma/schema.prisma` (enum at 52-55; `Transfer` 57-84; `TransferItem` 101-111; `User` 27-30)
- Create: `prisma/migrations/<generated>_property_returns/migration.sql`
- Modify: `src/modules/transfers/transfers.service.ts:63` and `:112-116`
- Modify: `src/app/globals.css` (add `.badge-open` / `.badge-closed`)

**Interfaces:**
- Produces: `enum TransferStatus { OPEN CLOSED }`; `TransferItem.returnedAt: DateTime?`; `enum ReturnKind { PARTIAL FULL }`; `model ReturnTransaction { id, transferId, receiptNumber, kind, processedByUserId?, processedByName, processedByEmail, returned Json, returnedCount, remainingCount, createdAt }`; `Transfer.returns ReturnTransaction[]`; `User.returnsProcessed ReturnTransaction[]`.

- [ ] **Step 1: Edit the schema — replace the enum (lines 52-55)**

```prisma
enum TransferStatus {
  OPEN
  CLOSED
}

enum ReturnKind {
  PARTIAL
  FULL
}
```

- [ ] **Step 2: Edit the schema — `Transfer.status` default + returns relation**

In `model Transfer` change line 82 and add a relation:

```prisma
  status    TransferStatus @default(OPEN)
  createdAt DateTime       @default(now())

  returns   ReturnTransaction[] @relation("TransferReturns")
```

- [ ] **Step 3: Edit the schema — `TransferItem.returnedAt`**

In `model TransferItem` add the column (after `serialNumber`, before the `@@index` lines):

```prisma
  serialNumber   String
  returnedAt     DateTime?
```

- [ ] **Step 4: Edit the schema — `User.returnsProcessed` relation**

In `model User` add to the relation block (after `importBatches`):

```prisma
  importBatches    ImportBatch[] @relation("ImportBatches")
  returnsProcessed ReturnTransaction[] @relation("ReturnsProcessed")
```

- [ ] **Step 5: Edit the schema — add the `ReturnTransaction` model (after `ImportBatch`, end of file)**

```prisma
model ReturnTransaction {
  id                String   @id @default(cuid())
  transfer          Transfer @relation("TransferReturns", fields: [transferId], references: [id], onDelete: Cascade)
  transferId        String
  receiptNumber     String
  kind              ReturnKind
  processedByUser   User?    @relation("ReturnsProcessed", fields: [processedByUserId], references: [id])
  processedByUserId String?
  processedByName   String
  processedByEmail  String
  returned          Json
  returnedCount     Int
  remainingCount    Int
  createdAt         DateTime @default(now())

  @@index([transferId])
}
```

- [ ] **Step 6: Generate the migration as a draft (do not auto-apply)**

Run: `npx prisma migrate dev --name property_returns --create-only`
Expected: prints a new folder `prisma/migrations/<timestamp>_property_returns/` with `migration.sql`. (Prisma may emit a destructive enum diff — you will overwrite it in the next step.)

- [ ] **Step 7: Overwrite that `migration.sql` with the data-preserving version**

Replace the whole generated `migration.sql` with exactly this (the enum block maps existing `COMPLETED`→`OPEN`, `VOID`→`CLOSED`; everything else is additive):

```sql
-- CreateEnum
CREATE TYPE "ReturnKind" AS ENUM ('PARTIAL', 'FULL');

-- AlterEnum: TransferStatus COMPLETED|VOID -> OPEN|CLOSED (preserve existing rows)
ALTER TYPE "TransferStatus" RENAME TO "TransferStatus_old";
CREATE TYPE "TransferStatus" AS ENUM ('OPEN', 'CLOSED');
ALTER TABLE "Transfer" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Transfer" ALTER COLUMN "status" TYPE "TransferStatus"
  USING (CASE "status"::text WHEN 'VOID' THEN 'CLOSED' ELSE 'OPEN' END)::"TransferStatus";
ALTER TABLE "Transfer" ALTER COLUMN "status" SET DEFAULT 'OPEN';
DROP TYPE "TransferStatus_old";

-- AlterTable
ALTER TABLE "TransferItem" ADD COLUMN "returnedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ReturnTransaction" (
    "id" TEXT NOT NULL,
    "transferId" TEXT NOT NULL,
    "receiptNumber" TEXT NOT NULL,
    "kind" "ReturnKind" NOT NULL,
    "processedByUserId" TEXT,
    "processedByName" TEXT NOT NULL,
    "processedByEmail" TEXT NOT NULL,
    "returned" JSONB NOT NULL,
    "returnedCount" INTEGER NOT NULL,
    "remainingCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReturnTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReturnTransaction_transferId_idx" ON "ReturnTransaction"("transferId");

-- AddForeignKey
ALTER TABLE "ReturnTransaction" ADD CONSTRAINT "ReturnTransaction_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "Transfer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnTransaction" ADD CONSTRAINT "ReturnTransaction_processedByUserId_fkey" FOREIGN KEY ("processedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

- [ ] **Step 8: Apply the migration to the dev DB and regenerate the client**

Run: `npx prisma migrate dev`
Expected: "Applying migration `<timestamp>_property_returns`" then "Your database is now in sync" and the Prisma Client regenerates. If it reports drift or a failed migration, fix the SQL — do NOT reset the database.

- [ ] **Step 9: Update the two hardcoded status references in `transfers.service.ts`**

Line 63 — new receipts are now open:

```ts
        createdByUserId: createdByUserId ?? null,
        status: "OPEN",
```

Lines 112-116 — `getLastReceiver` no longer filters on the removed `COMPLETED` value; "last receiver" is simply the most recent transfer for the item:

```ts
export async function getLastReceiver(itemId: string): Promise<PartyInput | null> {
  const last = await prisma.transfer.findFirst({
    where: { lines: { some: { items: { some: { itemId } } } } },
    orderBy: { createdAt: "desc" },
  });
```

- [ ] **Step 10: Add badge styles**

In `src/app/globals.css`, find the existing `.badge-*` rules (e.g. `.badge-completed`, `.badge-void`, `.badge-active`) and add two mirroring them — `.badge-open` styled like the existing "active/positive" badge (green), `.badge-closed` styled like the existing "muted/neutral" badge (gray). Match the surrounding declarations' colors/format exactly; do not invent a new visual language.

- [ ] **Step 11: Fix any test that asserts the old status value**

Run: `git grep -n "COMPLETED\|\"VOID\"" src` and update assertions in `src/modules/transfers/transfers.service.test.ts` (and any other hit) from `"COMPLETED"` to `"OPEN"`. Do not weaken assertions — just update the expected string.

- [ ] **Step 12: Run the full test suite**

Run: `npx vitest run`
Expected: PASS (all files green). The real-DB suites re-apply migrations to `handreceipt_test`, exercising the new SQL.

- [ ] **Step 13: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/modules/transfers/transfers.service.ts src/app/globals.css src/modules/transfers/transfers.service.test.ts
git commit -m "feat(returns): status OPEN/CLOSED, returnedAt, ReturnTransaction ledger"
```

---

### Task 2: Pure `planReturn`

**Files:**
- Create: `src/modules/returns/plan.ts`
- Test: `src/modules/returns/plan.test.ts`

**Interfaces:**
- Produces:
  - `type HeldItem = { transferItemId: string; serialNumber: string; make: string; model: string; lineNo: number }`
  - `type ReturnLineBalance = { lineNo: number; make: string; model: string; heldBefore: number; returnedNow: number; heldAfter: number }`
  - `type ReturnPlan = { kind: "PARTIAL" | "FULL"; returned: HeldItem[]; remaining: HeldItem[]; byLine: ReturnLineBalance[] }`
  - `function planReturn(held: HeldItem[], selectedItemIds: string[]): { plan?: ReturnPlan; error?: string }`
- Consumes: nothing (pure).

- [ ] **Step 1: Write the failing tests**

Create `src/modules/returns/plan.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { planReturn, type HeldItem } from "./plan";

const held: HeldItem[] = [
  { transferItemId: "a", serialNumber: "SN-A", make: "Dell", model: "5540", lineNo: 1 },
  { transferItemId: "b", serialNumber: "SN-B", make: "Dell", model: "5540", lineNo: 1 },
  { transferItemId: "c", serialNumber: "SN-C", make: "PVS", model: "14", lineNo: 2 },
];

describe("planReturn", () => {
  it("returns a subset as PARTIAL with per-line before/after counts", () => {
    const { plan, error } = planReturn(held, ["a"]);
    expect(error).toBeUndefined();
    expect(plan!.kind).toBe("PARTIAL");
    expect(plan!.returned.map((r) => r.transferItemId)).toEqual(["a"]);
    expect(plan!.remaining.map((r) => r.transferItemId).sort()).toEqual(["b", "c"]);
    const line1 = plan!.byLine.find((l) => l.lineNo === 1)!;
    expect(line1).toMatchObject({ heldBefore: 2, returnedNow: 1, heldAfter: 1 });
    const line2 = plan!.byLine.find((l) => l.lineNo === 2)!;
    expect(line2).toMatchObject({ heldBefore: 1, returnedNow: 0, heldAfter: 1 });
  });

  it("returns everything as FULL", () => {
    const { plan } = planReturn(held, ["a", "b", "c"]);
    expect(plan!.kind).toBe("FULL");
    expect(plan!.remaining).toHaveLength(0);
    expect(plan!.byLine.every((l) => l.heldAfter === 0)).toBe(true);
  });

  it("dedupes repeated ids", () => {
    const { plan } = planReturn(held, ["a", "a"]);
    expect(plan!.returned).toHaveLength(1);
  });

  it("errors on an empty selection", () => {
    const { plan, error } = planReturn(held, []);
    expect(plan).toBeUndefined();
    expect(error).toMatch(/at least one/i);
  });

  it("errors when a selected id is not currently held", () => {
    const { plan, error } = planReturn(held, ["zzz"]);
    expect(plan).toBeUndefined();
    expect(error).toMatch(/not currently held/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/modules/returns/plan.test.ts`
Expected: FAIL — cannot resolve `./plan`.

- [ ] **Step 3: Implement `plan.ts`**

Create `src/modules/returns/plan.ts`:

```ts
export type HeldItem = {
  transferItemId: string;
  serialNumber: string;
  make: string;
  model: string;
  lineNo: number;
};

export type ReturnLineBalance = {
  lineNo: number;
  make: string;
  model: string;
  heldBefore: number;
  returnedNow: number;
  heldAfter: number;
};

export type ReturnPlan = {
  kind: "PARTIAL" | "FULL";
  returned: HeldItem[];
  remaining: HeldItem[];
  byLine: ReturnLineBalance[];
};

// Pure: decide which held items are returned vs remain, classify the return as
// PARTIAL or FULL, and compute per-line before/after balances for the redline
// UI and the email. No DB access; `selectedItemIds` are TransferItem ids.
export function planReturn(
  held: HeldItem[],
  selectedItemIds: string[]
): { plan?: ReturnPlan; error?: string } {
  const selected = new Set(selectedItemIds.filter(Boolean));
  if (selected.size === 0) return { error: "Select at least one serial number to return." };

  const heldById = new Map(held.map((h) => [h.transferItemId, h]));
  for (const id of selected) {
    if (!heldById.has(id)) return { error: "A selected item is not currently held on this receipt." };
  }

  const returned = held.filter((h) => selected.has(h.transferItemId));
  const remaining = held.filter((h) => !selected.has(h.transferItemId));
  const kind = remaining.length === 0 ? "FULL" : "PARTIAL";

  const byLine: ReturnLineBalance[] = [];
  const seen = new Map<number, ReturnLineBalance>();
  for (const h of held) {
    let b = seen.get(h.lineNo);
    if (!b) {
      b = { lineNo: h.lineNo, make: h.make, model: h.model, heldBefore: 0, returnedNow: 0, heldAfter: 0 };
      seen.set(h.lineNo, b);
      byLine.push(b);
    }
    b.heldBefore += 1;
    if (selected.has(h.transferItemId)) b.returnedNow += 1;
    else b.heldAfter += 1;
  }
  byLine.sort((x, y) => x.lineNo - y.lineNo);

  return { plan: { kind, returned, remaining, byLine } };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/modules/returns/plan.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/returns/plan.ts src/modules/returns/plan.test.ts
git commit -m "feat(returns): pure planReturn (partial/full + per-line balances)"
```

---

### Task 3: `processReturn` service (real-DB)

**Files:**
- Create: `src/modules/returns/returns.errors.ts`
- Create: `src/modules/returns/returns.service.ts`
- Test: `src/modules/returns/returns.service.test.ts`

**Interfaces:**
- Consumes: `planReturn`, `HeldItem`, `ReturnPlan` (Task 2); `prisma` from `@/lib/prisma`; `createTransfer`, `getTransferByReceiptNumber` (transfers.service) for the test.
- Produces:
  - `class ReturnError extends Error { code: "NOT_FOUND" | "CLOSED" | "INVALID" }`
  - `type ProcessReturnInput = { receiptNumber: string; selectedItemIds: string[]; processedBy: { id: string; name: string; email: string } }`
  - `type ProcessReturnResult = { plan: ReturnPlan; receiptNumber: string; receiver: { isDcsim: boolean; name: string; email: string | null } } | { error: string }`
  - `async function processReturn(input: ProcessReturnInput): Promise<ProcessReturnResult>`

- [ ] **Step 1: Write the failing test**

Create `src/modules/returns/returns.service.test.ts`:

```ts
import { beforeAll, beforeEach, expect, test } from "vitest";
import prisma from "@/lib/prisma";
import { resetDb, migrateTestDb } from "../../../tests/helpers/db";
import { createTransfer, getTransferByReceiptNumber } from "@/modules/transfers/transfers.service";
import { createItem } from "@/modules/items/items.service";
import { processReturn } from "./returns.service";

let adminId: string;
beforeAll(() => migrateTestDb());
beforeEach(async () => {
  await resetDb();
  const admin = await prisma.user.create({ data: { name: "Tech", email: "t@x.co", passwordHash: "x", role: "ADMIN" } });
  adminId = admin.id;
});

// Build a receipt holding two Dell 5540 (one line, two serials).
async function seedReceipt() {
  const a = await createItem({ make: "Dell", model: "5540", serialNumber: "SN-A", homeUnit: undefined, notes: undefined }, adminId);
  const b = await createItem({ make: "Dell", model: "5540", serialNumber: "SN-B", homeUnit: undefined, notes: undefined }, adminId);
  const t = await createTransfer({
    itemIds: [a.id, b.id],
    lines: [{ make: "Dell", model: "5540", qtyAuth: 2, qtyIssued: 2 }],
    sender: { isDcsim: true, name: "Desk" },
    receiver: { isDcsim: false, name: "Jane", email: "jane@u.mil" },
    receiverSignature: "",
    createdByUserId: adminId,
  });
  const full = (await getTransferByReceiptNumber(t.receiptNumber))!;
  return { receiptNumber: t.receiptNumber, items: full.lines[0].items };
}

const processedBy = () => ({ id: adminId, name: "Tech", email: "t@x.co" });

test("partial return stamps returnedAt, writes a PARTIAL ledger row, keeps the receipt OPEN", async () => {
  const { receiptNumber, items } = await seedReceipt();
  const res = await processReturn({ receiptNumber, selectedItemIds: [items[0].id], processedBy: processedBy() });
  if ("error" in res) throw new Error(res.error);
  expect(res.plan.kind).toBe("PARTIAL");

  const after = (await getTransferByReceiptNumber(receiptNumber))!;
  expect(after.status).toBe("OPEN");
  const returned = after.lines[0].items.filter((i) => i.returnedAt !== null);
  expect(returned).toHaveLength(1);
  expect(returned[0].id).toBe(items[0].id);

  const ledger = await prisma.returnTransaction.findMany();
  expect(ledger).toHaveLength(1);
  expect(ledger[0]).toMatchObject({ kind: "PARTIAL", returnedCount: 1, remainingCount: 1, receiptNumber });
});

test("returning the last held item closes the receipt as FULL", async () => {
  const { receiptNumber, items } = await seedReceipt();
  await processReturn({ receiptNumber, selectedItemIds: [items[0].id], processedBy: processedBy() });
  const res = await processReturn({ receiptNumber, selectedItemIds: [items[1].id], processedBy: processedBy() });
  if ("error" in res) throw new Error(res.error);
  expect(res.plan.kind).toBe("FULL");

  const after = (await getTransferByReceiptNumber(receiptNumber))!;
  expect(after.status).toBe("CLOSED");
  expect(after.lines[0].items.every((i) => i.returnedAt !== null)).toBe(true);
  expect(await prisma.returnTransaction.count()).toBe(2);
});

test("a return against a CLOSED receipt errors and writes nothing", async () => {
  const { receiptNumber, items } = await seedReceipt();
  await processReturn({ receiptNumber, selectedItemIds: [items[0].id, items[1].id], processedBy: processedBy() });
  const before = await prisma.returnTransaction.count();
  const res = await processReturn({ receiptNumber, selectedItemIds: [items[0].id], processedBy: processedBy() });
  expect("error" in res && res.error).toMatch(/closed/i);
  expect(await prisma.returnTransaction.count()).toBe(before);
});

test("selecting an already-returned item errors", async () => {
  const { receiptNumber, items } = await seedReceipt();
  await processReturn({ receiptNumber, selectedItemIds: [items[0].id], processedBy: processedBy() });
  const res = await processReturn({ receiptNumber, selectedItemIds: [items[0].id], processedBy: processedBy() });
  expect("error" in res && res.error).toMatch(/not currently held/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/modules/returns/returns.service.test.ts`
Expected: FAIL — cannot resolve `./returns.service`.

- [ ] **Step 3: Implement `returns.errors.ts`**

```ts
export class ReturnError extends Error {
  constructor(public code: "NOT_FOUND" | "CLOSED" | "INVALID", message?: string) {
    super(message ?? code);
    this.name = "ReturnError";
  }
}
```

- [ ] **Step 4: Implement `returns.service.ts`**

```ts
import prisma from "@/lib/prisma";
import { planReturn, type HeldItem, type ReturnPlan } from "./plan";
import { ReturnError } from "./returns.errors";

export type ProcessReturnInput = {
  receiptNumber: string;
  selectedItemIds: string[];
  processedBy: { id: string; name: string; email: string };
};

export type ProcessReturnResult =
  | { plan: ReturnPlan; receiptNumber: string; receiver: { isDcsim: boolean; name: string; email: string | null } }
  | { error: string };

// Everything runs inside one transaction so the receipt is read, validated, and
// mutated atomically — no window for a concurrent return to double-return an
// item or race the OPEN->CLOSED transition.
export async function processReturn(input: ProcessReturnInput): Promise<ProcessReturnResult> {
  const { receiptNumber, selectedItemIds, processedBy } = input;
  try {
    return await prisma.$transaction(async (tx) => {
      const receipt = await tx.transfer.findUnique({
        where: { receiptNumber: receiptNumber.toUpperCase() },
        include: { lines: { orderBy: { lineNo: "asc" }, include: { items: true } } },
      });
      if (!receipt) throw new ReturnError("NOT_FOUND", "Receipt not found.");
      if (receipt.status !== "OPEN") throw new ReturnError("CLOSED", "This receipt is already closed.");

      const held: HeldItem[] = receipt.lines.flatMap((l) =>
        l.items
          .filter((it) => it.returnedAt === null)
          .map((it) => ({ transferItemId: it.id, serialNumber: it.serialNumber, make: l.make, model: l.model, lineNo: l.lineNo }))
      );

      const { plan, error } = planReturn(held, selectedItemIds);
      if (error || !plan) throw new ReturnError("INVALID", error ?? "Invalid return.");

      const returnedIds = plan.returned.map((r) => r.transferItemId);
      await tx.transferItem.updateMany({ where: { id: { in: returnedIds } }, data: { returnedAt: new Date() } });

      if (plan.kind === "FULL") {
        await tx.transfer.update({ where: { id: receipt.id }, data: { status: "CLOSED" } });
      }

      await tx.returnTransaction.create({
        data: {
          transferId: receipt.id,
          receiptNumber: receipt.receiptNumber,
          kind: plan.kind,
          processedByUserId: processedBy.id,
          processedByName: processedBy.name,
          processedByEmail: processedBy.email,
          returned: plan.returned.map((r) => ({ serialNumber: r.serialNumber, make: r.make, model: r.model })),
          returnedCount: plan.returned.length,
          remainingCount: plan.remaining.length,
        },
      });

      return {
        plan,
        receiptNumber: receipt.receiptNumber,
        receiver: { isDcsim: receipt.receiverIsDcsim, name: receipt.receiverName, email: receipt.receiverEmail },
      };
    });
  } catch (e) {
    if (e instanceof ReturnError) return { error: e.message };
    throw e;
  }
}

export function listReturnsForReceipt(transferId: string) {
  return prisma.returnTransaction.findMany({ where: { transferId }, orderBy: { createdAt: "asc" } });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/modules/returns/returns.service.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/modules/returns/returns.errors.ts src/modules/returns/returns.service.ts src/modules/returns/returns.service.test.ts
git commit -m "feat(returns): processReturn service (atomic apply + ledger)"
```

---

### Task 4: Email layer — CC support + `sendReturnEmail`

**Files:**
- Modify: `src/lib/email.ts:1` and `:8-9` and `:19`
- Create: `src/modules/returns/send-return-email.ts`
- Test: `src/modules/returns/send-return-email.test.ts`

**Interfaces:**
- Consumes: `EmailSender`, `getEmailSender`, `EmailMessage` (email.ts); `ReturnLineBalance` (plan.ts); `formatDateTimeHST` (`@/lib/datetime`).
- Produces:
  - `EmailMessage` gains `cc?: string | string[]`.
  - `type ReturnEmailArgs = { receiver: { isDcsim: boolean; name: string; email: string | null }; receiptNumber: string; receiptUrl: string; kind: "PARTIAL" | "FULL"; returned: { serialNumber: string; make: string; model: string }[]; byLine: ReturnLineBalance[]; processedByName: string; processedByEmail: string; processedAt: Date }`
  - `async function sendReturnEmail(args: ReturnEmailArgs, deps?: { sender?: EmailSender }): Promise<void>`

- [ ] **Step 1: Add `cc` to the email layer**

In `src/lib/email.ts`, line 1:

```ts
export type EmailMessage = { to: string; subject: string; text: string; html?: string; cc?: string | string[] };
```

In `ResendEmailSender.send` (line 19), include `cc` in the body (JSON.stringify drops it when undefined):

```ts
      body: JSON.stringify({ from: this.from, to: msg.to, cc: msg.cc, subject: msg.subject, text: msg.text, html: msg.html }),
```

In `LogEmailSender.send` (lines 8-9), surface cc in the log line:

```ts
  async send(msg: EmailMessage): Promise<void> {
    console.info(`[email:stub] to=${msg.to}${msg.cc ? ` cc=${msg.cc}` : ""} subject=${JSON.stringify(msg.subject)}\n${msg.text}`);
  }
```

- [ ] **Step 2: Write the failing tests**

Create `src/modules/returns/send-return-email.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { sendReturnEmail, type ReturnEmailArgs } from "./send-return-email";
import type { EmailMessage } from "@/lib/email";

const orig = { ...process.env };
afterEach(() => { process.env = { ...orig }; });

const base: ReturnEmailArgs = {
  receiver: { isDcsim: false, name: "Jane", email: "jane@u.mil" },
  receiptNumber: "HR-000123",
  receiptUrl: "https://x/receipts/HR-000123",
  kind: "PARTIAL",
  returned: [{ serialNumber: "SN-A", make: "Dell", model: "5540" }],
  byLine: [{ lineNo: 1, make: "Dell", model: "5540", heldBefore: 2, returnedNow: 1, heldAfter: 1 }],
  processedByName: "Tech",
  processedByEmail: "tech@g6.mil",
  processedAt: new Date("2026-07-09T20:00:00Z"),
};

describe("sendReturnEmail", () => {
  it("emails the receiver, CCs the desk, and uses the partial subject", async () => {
    process.env.G6_SERVICE_DESK_EMAIL = "desk@g6.mil";
    const send = vi.fn(async (_m: EmailMessage) => {});
    await sendReturnEmail(base, { sender: { send } });
    const msg = send.mock.calls[0][0];
    expect(msg.to).toBe("jane@u.mil");
    expect(msg.cc).toBe("desk@g6.mil");
    expect(msg.subject).toBe("UPDATE: G6 Digital Hand Receipt - Partial Property Return Confirmation [ID: HR-000123]");
    expect(msg.text).toContain("SN-A");
    expect(msg.text).toContain("AR 735-5");
  });

  it("uses the clearance subject and CLEARED banner on a full return", async () => {
    const send = vi.fn(async (_m: EmailMessage) => {});
    await sendReturnEmail({ ...base, kind: "FULL", byLine: [{ ...base.byLine[0], returnedNow: 2, heldAfter: 0 }] }, { sender: { send } });
    const msg = send.mock.calls[0][0];
    expect(msg.subject).toBe("CLEARANCE RECORD: G6 Digital Hand Receipt - Final Property Return [ID: HR-000123]");
    expect(msg.text).toMatch(/CLEARED/);
  });

  it("omits CC when the desk env var is unset", async () => {
    delete process.env.G6_SERVICE_DESK_EMAIL;
    const send = vi.fn(async (_m: EmailMessage) => {});
    await sendReturnEmail(base, { sender: { send } });
    expect(send.mock.calls[0][0].cc).toBeUndefined();
  });

  it("falls back to the desk as recipient when the receiver has no email", async () => {
    process.env.G6_SERVICE_DESK_EMAIL = "desk@g6.mil";
    const send = vi.fn(async (_m: EmailMessage) => {});
    await sendReturnEmail({ ...base, receiver: { isDcsim: false, name: "Jane", email: null } }, { sender: { send } });
    const msg = send.mock.calls[0][0];
    expect(msg.to).toBe("desk@g6.mil");
    expect(msg.cc).toBeUndefined();
  });

  it("never throws when the sender fails", async () => {
    const send = vi.fn(async () => { throw new Error("boom"); });
    await expect(sendReturnEmail(base, { sender: { send } })).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/modules/returns/send-return-email.test.ts`
Expected: FAIL — cannot resolve `./send-return-email`.

- [ ] **Step 4: Implement `send-return-email.ts`**

```ts
import { getEmailSender, type EmailSender } from "@/lib/email";
import type { ReturnLineBalance } from "./plan";
import { formatDateTimeHST } from "@/lib/datetime";

export type ReturnEmailArgs = {
  receiver: { isDcsim: boolean; name: string; email: string | null };
  receiptNumber: string;
  receiptUrl: string;
  kind: "PARTIAL" | "FULL";
  returned: { serialNumber: string; make: string; model: string }[];
  byLine: ReturnLineBalance[];
  processedByName: string;
  processedByEmail: string;
  processedAt: Date;
};

function partialBody(a: ReturnEmailArgs): string {
  const items = a.returned.map((r) => `  - ${r.make} ${r.model} (SN ${r.serialNumber})`).join("\n");
  const balances = a.byLine
    .filter((l) => l.returnedNow > 0)
    .map((l) => `  - ${l.make} ${l.model}: Old: ${l.heldBefore} -> New Remaining: ${l.heldAfter}`)
    .join("\n");
  return [
    `A partial property return has been processed by the G6 service desk for hand receipt ${a.receiptNumber}.`,
    ``,
    `Items returned today (${a.returned.length}):`,
    items,
    ``,
    `New remaining balance still in your custody:`,
    balances,
    ``,
    `You remain financially liable for the remaining items under AR 735-5 until they are returned.`,
    ``,
    `View your hand receipt:`,
    a.receiptUrl,
    ``,
    `Processed by ${a.processedByName} (${a.processedByEmail}) on ${formatDateTimeHST(a.processedAt)}.`,
  ].join("\n");
}

function fullBody(a: ReturnEmailArgs): string {
  const items = a.returned.map((r) => `  - ${r.make} ${r.model} (SN ${r.serialNumber})`).join("\n");
  return [
    `All remaining equipment on hand receipt ${a.receiptNumber} has been returned and verified by the G6 service desk.`,
    ``,
    `**** STATUS: CLEARED / CLOSED ****`,
    ``,
    `Items turned in today (${a.returned.length}):`,
    items,
    ``,
    `Your active balance for this hand receipt is now zero. Your accountability is officially closed and you are no longer financially liable for tracking ID ${a.receiptNumber}.`,
    ``,
    `A closed-out copy of the form (marked VOID / CLEARED) is available here:`,
    a.receiptUrl,
    ``,
    `Save this email as your digital clearance record for out-processing, PCS, or ETS.`,
    ``,
    `Cleared by ${a.processedByName} (${a.processedByEmail}) on ${formatDateTimeHST(a.processedAt)}.`,
  ].join("\n");
}

// Notifies the customer of a return (CC the G6 desk). Best-effort: a send
// failure is logged and swallowed so it never rolls back the committed return.
export async function sendReturnEmail(args: ReturnEmailArgs, deps: { sender?: EmailSender } = {}): Promise<void> {
  const sender = deps.sender ?? getEmailSender();
  const desk = process.env.G6_SERVICE_DESK_EMAIL;
  const customer = !args.receiver.isDcsim && args.receiver.email ? args.receiver.email : undefined;

  const to = customer ?? desk;
  if (!to) return; // nobody to notify
  const cc = to !== desk ? desk : undefined; // don't CC the same address we're sending to

  const subject =
    args.kind === "FULL"
      ? `CLEARANCE RECORD: G6 Digital Hand Receipt - Final Property Return [ID: ${args.receiptNumber}]`
      : `UPDATE: G6 Digital Hand Receipt - Partial Property Return Confirmation [ID: ${args.receiptNumber}]`;

  const text = args.kind === "FULL" ? fullBody(args) : partialBody(args);

  try {
    await sender.send({ to, cc, subject, text });
  } catch (e) {
    console.error(`[return-email] failed to email ${to}:`, e);
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/modules/returns/send-return-email.test.ts src/lib/email.test.ts`
Expected: PASS (existing email tests + 5 new).

- [ ] **Step 6: Commit**

```bash
git add src/lib/email.ts src/modules/returns/send-return-email.ts src/modules/returns/send-return-email.test.ts
git commit -m "feat(returns): email cc support + partial/full return notifications"
```

---

### Task 5: Server action + return page + form

**Files:**
- Create: `src/app/actions/returns.ts`
- Create: `src/app/receipts/[receiptNumber]/return/page.tsx`
- Create: `src/app/receipts/[receiptNumber]/return/ReturnForm.tsx`

**Interfaces:**
- Consumes: `requireAdmin`, `AuthError` (authz); `processReturn` (Task 3); `sendReturnEmail` (Task 4); `receiptUrl` (`@/modules/items/qr`); `getTransferByReceiptNumber` (transfers.service); `SiteHeader` (`@/components/SiteHeader`); `ReturnPlan`/`HeldItem` (Task 2).
- Produces:
  - `async function processReturnAction(prev, formData): Promise<{ ok: true; plan: ReturnPlan; receiptNumber: string; closed: boolean } | { error: string }>`
  - The admin return page and its client form.

- [ ] **Step 1: Implement the server action `src/app/actions/returns.ts`**

```ts
"use server";
import { revalidatePath } from "next/cache";
import { requireAdmin, AuthError } from "@/lib/authz";
import { processReturn } from "@/modules/returns/returns.service";
import { sendReturnEmail } from "@/modules/returns/send-return-email";
import { receiptUrl } from "@/modules/items/qr";
import type { ReturnPlan } from "@/modules/returns/plan";

type Result = { ok: true; plan: ReturnPlan; receiptNumber: string; closed: boolean } | { error: string };

export async function processReturnAction(_prev: unknown, formData: FormData): Promise<Result> {
  let admin;
  try {
    admin = await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) return { error: "You are not authorized to process returns." };
    throw e;
  }

  const receiptNumber = String(formData.get("receiptNumber") ?? "");
  const verified = formData.get("verified") === "on";
  if (!verified) return { error: "You must confirm you physically verified the serial numbers before submitting." };

  const selectedItemIds = formData.getAll("itemId").map(String).filter(Boolean);
  if (selectedItemIds.length === 0) return { error: "Select at least one serial number to return." };

  try {
    const res = await processReturn({
      receiptNumber,
      selectedItemIds,
      processedBy: { id: admin.id, name: admin.name, email: admin.email },
    });
    if ("error" in res) return { error: res.error };

    revalidatePath(`/receipts/${res.receiptNumber}`);
    revalidatePath("/admin/audit");

    try {
      await sendReturnEmail({
        receiver: res.receiver,
        receiptNumber: res.receiptNumber,
        receiptUrl: receiptUrl(res.receiptNumber),
        kind: res.plan.kind,
        returned: res.plan.returned.map((r) => ({ serialNumber: r.serialNumber, make: r.make, model: r.model })),
        byLine: res.plan.byLine,
        processedByName: admin.name,
        processedByEmail: admin.email,
        processedAt: new Date(),
      });
    } catch (err) {
      console.error("[processReturnAction] return email failed:", err);
    }

    return { ok: true, plan: res.plan, receiptNumber: res.receiptNumber, closed: res.plan.kind === "FULL" };
  } catch (e) {
    console.error("[processReturnAction] unexpected error:", e);
    return { error: "Something went wrong processing the return. Please try again." };
  }
}
```

- [ ] **Step 2: Implement the admin return page `.../return/page.tsx`**

```tsx
import { notFound, redirect } from "next/navigation";
import { requireAdmin, AuthError } from "@/lib/authz";
import { getTransferByReceiptNumber } from "@/modules/transfers/transfers.service";
import { SiteHeader } from "@/components/SiteHeader";
import { ReturnForm } from "./ReturnForm";

export default async function ReturnPage({ params }: { params: Promise<{ receiptNumber: string }> }) {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) redirect(e.code === "FORBIDDEN" ? "/" : "/login");
    throw e;
  }

  const { receiptNumber } = await params;
  const t = await getTransferByReceiptNumber(receiptNumber);
  if (!t) notFound();
  if (t.status !== "OPEN") redirect(`/receipts/${t.receiptNumber}`);

  const held = t.lines.flatMap((l) =>
    l.items
      .filter((it) => it.returnedAt === null)
      .map((it) => ({ transferItemId: it.id, serialNumber: it.serialNumber, make: l.make, model: l.model, lineNo: l.lineNo }))
  );

  return (
    <>
      <SiteHeader />
      <main className="container container-mid stack">
        <h1 className="page-title">Process return — {t.receiptNumber}</h1>
        <p className="subtle">Check off each serial number physically turned in. Returning every held item closes the receipt.</p>
        <ReturnForm receiptNumber={t.receiptNumber} held={held} />
      </main>
    </>
  );
}
```

- [ ] **Step 3: Implement the client form `.../return/ReturnForm.tsx`**

```tsx
"use client";
import { useActionState, useMemo, useState } from "react";
import { processReturnAction } from "@/app/actions/returns";
import type { HeldItem } from "@/modules/returns/plan";

const VERIFY_LABEL = "I have physically verified that the serial number on the device matches the screen";

export function ReturnForm({ receiptNumber, held }: { receiptNumber: string; held: HeldItem[] }) {
  const [state, action, pending] = useActionState(processReturnAction, undefined);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [verified, setVerified] = useState(false);

  const lines = useMemo(() => {
    const by = new Map<number, { lineNo: number; make: string; model: string; items: HeldItem[] }>();
    for (const h of held) {
      let g = by.get(h.lineNo);
      if (!g) { g = { lineNo: h.lineNo, make: h.make, model: h.model, items: [] }; by.set(h.lineNo, g); }
      g.items.push(h);
    }
    return [...by.values()].sort((a, b) => a.lineNo - b.lineNo);
  }, [held]);

  function toggle(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function returnAll() { setChecked(new Set(held.map((h) => h.transferItemId))); }

  if (state && "ok" in state) {
    return (
      <div className="card stack-sm">
        <h2 className="card__title">{state.closed ? "Receipt cleared and closed" : "Partial return processed"}</h2>
        <ul>
          {state.plan.byLine.filter((l) => l.returnedNow > 0).map((l) => (
            <li key={l.lineNo}>
              {l.make} {l.model}: <s className="subtle">{l.heldBefore}</s>{" "}
              <strong>{l.heldAfter}</strong> remaining
            </li>
          ))}
        </ul>
        <p className="subtle">A confirmation email has been sent to the customer{state.closed ? " with the clearance record" : ""}.</p>
        <div className="row">
          <a className="btn btn-primary" href={`/receipts/${state.receiptNumber}`}>View receipt</a>
          <a className="btn btn-ghost" href="/items">Back to items</a>
        </div>
      </div>
    );
  }

  const canSubmit = checked.size > 0 && verified && !pending;

  return (
    <form action={action} className="stack">
      <input type="hidden" name="receiptNumber" value={receiptNumber} />
      {lines.map((ln) => (
        <fieldset key={ln.lineNo} className="card stack-sm">
          <legend className="card__title">{ln.make} {ln.model}</legend>
          {ln.items.map((it) => (
            <label key={it.transferItemId} className="row">
              <input type="checkbox" name="itemId" value={it.transferItemId} checked={checked.has(it.transferItemId)} onChange={() => toggle(it.transferItemId)} />
              <span className="mono">{it.serialNumber}</span>
            </label>
          ))}
        </fieldset>
      ))}
      <div className="row">
        <button type="button" className="btn btn-secondary" onClick={returnAll}>Return all remaining</button>
      </div>
      <label className="row">
        <input type="checkbox" name="verified" checked={verified} onChange={(e) => setVerified(e.target.checked)} />
        {VERIFY_LABEL}
      </label>
      <div className="row">
        <button className="btn btn-primary" disabled={!canSubmit} type="submit">
          {pending ? "Processing…" : "Process return"}
        </button>
        {state && "error" in state && state.error && <span role="alert" className="alert-error">{state.error}</span>}
      </div>
    </form>
  );
}
```

- [ ] **Step 4: Verify lint + build**

Run: `npm run lint && npm run build`
Expected: lint clean; build succeeds (the new route compiles).

- [ ] **Step 5: Commit**

```bash
git add src/app/actions/returns.ts "src/app/receipts/[receiptNumber]/return"
git commit -m "feat(returns): admin return page, serial check-off form, and action"
```

---

### Task 6: Receipt page redline + CLOSED state + audit section

**Files:**
- Modify: `src/app/receipts/[receiptNumber]/page.tsx` (full rewrite of the render)
- Modify: `src/app/admin/audit/page.tsx` (add a "Property returns" section)

**Interfaces:**
- Consumes: `getCurrentUser` (`@/lib/session`); `getTransferByReceiptNumber` (transfers.service); `prisma` (audit page); `formatDateTimeHST`, `formatParty`, `SiteHeader`, `StatusBadge`.
- Produces: no new exports.

- [ ] **Step 1: Rewrite the receipt page to show balances, the CLOSED banner, and the admin button**

Replace the body of `src/app/receipts/[receiptNumber]/page.tsx` with:

```tsx
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTransferByReceiptNumber } from "@/modules/transfers/transfers.service";
import { formatParty } from "@/modules/transfers/party";
import { formatDateTimeHST } from "@/lib/datetime";
import { SiteHeader } from "@/components/SiteHeader";
import { getCurrentUser } from "@/lib/session";

export default async function ReceiptPage({ params }: { params: Promise<{ receiptNumber: string }> }) {
  const { receiptNumber } = await params;
  const t = await getTransferByReceiptNumber(receiptNumber);
  if (!t) notFound();

  const me = await getCurrentUser();
  const isAdmin = me?.role === "ADMIN";
  const closed = t.status === "CLOSED";

  return (
    <>
      <SiteHeader />
      <main className="container container-mid stack">
        <h1 className="page-title">Hand receipt {t.receiptNumber}</h1>

        {closed && (
          <div className="card alert-error" role="status">
            <strong>VOID / CLEARED</strong> — all equipment returned. This receipt is closed and read-only.
          </div>
        )}

        <div className="card stack-sm">
          <div>
            <strong>Items:</strong>
            <ul>
              {t.lines.map((ln) => {
                const total = ln.items.length;
                const held = ln.items.filter((it) => it.returnedAt === null).length;
                const partiallyReturned = held < total;
                return (
                  <li key={ln.id}>
                    {ln.make} {ln.model} — auth {ln.qtyAuth} / issued {ln.qtyIssued} {ln.unitOfIssue}
                    {" "}(SN {ln.items.map((it) => it.serialNumber).join(", ")})
                    {partiallyReturned && (
                      <>
                        {" — held: "}
                        <s className="subtle">{total}</s> <strong>{held}</strong>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
          <div><strong>From:</strong> {formatParty({ isDcsim: t.senderIsDcsim, name: t.senderName, rank: t.senderRank, unit: t.senderUnit })}</div>
          <div><strong>To:</strong> {formatParty({ isDcsim: t.receiverIsDcsim, name: t.receiverName, rank: t.receiverRank, unit: t.receiverUnit })}</div>
          <div><strong>Date:</strong> {formatDateTimeHST(t.createdAt)}</div>
          <div><strong>Status:</strong> {t.status}</div>
        </div>

        <div className="row">
          {isAdmin && !closed && (
            <a className="btn btn-primary" href={`/receipts/${t.receiptNumber}/return`}>Process return</a>
          )}
          <a className="btn btn-secondary" href={`/receipts/${t.receiptNumber}/pdf?preview=1`} target="_blank" rel="noopener noreferrer">Preview PDF</a>
          <a className="btn btn-secondary" href={`/receipts/${t.receiptNumber}/pdf`}>Download PDF</a>
          <Link className="btn btn-ghost" href="/">Search another</Link>
        </div>
      </main>
    </>
  );
}
```

- [ ] **Step 2: Add the "Property returns" section to the audit page**

In `src/app/admin/audit/page.tsx`, after the `imports` query (line 21), add:

```ts
  const returns = await prisma.returnTransaction.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
  });
```

Then, immediately after the closing `)}` of the `{imports.length > 0 && (...)}` block (line 56), insert:

```tsx
      {returns.length > 0 && (
        <div className="stack-sm">
          <h2 className="card__title">Property returns</h2>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Date</th><th>By</th><th>Receipt</th><th>Kind</th><th>Returned</th><th>Remaining</th></tr>
              </thead>
              <tbody>
                {returns.map((r) => {
                  const items = Array.isArray(r.returned) ? (r.returned as { serialNumber: string }[]) : [];
                  return (
                    <tr key={r.id}>
                      <td className="subtle" data-label="Date">{formatDateTimeHST(r.createdAt)}</td>
                      <td data-label="By">{r.processedByName}</td>
                      <td data-label="Receipt"><Link href={`/receipts/${r.receiptNumber}`}>{r.receiptNumber}</Link></td>
                      <td data-label="Kind">{r.kind}</td>
                      <td data-label="Returned">
                        {r.returnedCount}
                        {items.length > 0 && <span className="subtle"> ({items.map((i) => i.serialNumber || "?").join(", ")})</span>}
                      </td>
                      <td data-label="Remaining">{r.remainingCount}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
```

- [ ] **Step 3: Verify lint + build**

Run: `npm run lint && npm run build`
Expected: lint clean; build succeeds.

- [ ] **Step 4: Commit**

```bash
git add "src/app/receipts/[receiptNumber]/page.tsx" src/app/admin/audit/page.tsx
git commit -m "feat(returns): receipt-page redline + CLOSED banner + audit section"
```

---

### Task 7: PDF VOID/CLEARED overlay

**Files:**
- Modify: `src/modules/receipts/hand-receipt.ts` (add overlay after the guard bars, ~line 158)
- Test: `src/modules/receipts/hand-receipt.test.ts` (add a CLOSED smoke test)

**Interfaces:**
- Consumes: `ReceiptData` (already has `status: string`); `rgb`, `degrees` (already imported at line 1).
- Produces: no new exports — behavior keyed off `t.status === "CLOSED"`.

- [ ] **Step 1: Write the failing smoke test**

Open `src/modules/receipts/hand-receipt.test.ts`, read its existing helper that constructs a `ReceiptData`, and add a test mirroring it. It must assert that a CLOSED receipt renders without throwing and yields a non-trivial PDF:

```ts
test("renders a CLOSED receipt with the VOID/CLEARED overlay without throwing", async () => {
  // Reuse this file's existing ReceiptData factory/fixture; override status.
  const bytes = await buildHandReceiptPdf({ ...baseReceiptData, status: "CLOSED" });
  expect(bytes).toBeInstanceOf(Uint8Array);
  expect(bytes.length).toBeGreaterThan(1000);
});
```

(Use whatever the file already calls its fixture — `baseReceiptData` here is a placeholder for the existing one. If none exists, build a minimal `ReceiptData` inline with one line, empty `receiverSignature`, `status: "CLOSED"`.)

- [ ] **Step 2: Run it to verify it fails or passes trivially**

Run: `npx vitest run src/modules/receipts/hand-receipt.test.ts`
Expected: the new test PASSES even before the overlay (rendering already succeeds) — that's fine; it is a regression guard. Proceed to add the overlay and confirm it still passes.

- [ ] **Step 3: Add the overlay in `hand-receipt.ts`**

Immediately after the second guard-bar block (after line 158, before the `// --- Custody record page:` comment at line 160), insert:

```ts
  // When the receipt is closed (all property returned), stamp the form page with
  // a diagonal VOID/CLEARED watermark and strike the recipient signature block,
  // per the DA 2062 "redline" clear-out treatment.
  if (t.status === "CLOSED") {
    const red = rgb(0.78, 0.12, 0.12);
    const { width, height } = page1.getSize();
    page1.drawText("VOID / CLEARED", {
      x: width * 0.12,
      y: height * 0.42,
      size: 54,
      font: bold,
      color: red,
      rotate: degrees(35),
      opacity: 0.28,
    });
    // Strike through the vertical signature block in muted red.
    page1.drawLine({
      start: { x: colLeft - 2, y: sigBottom },
      end: { x: colLeft + colWidth + 2, y: blockTop + 2 },
      thickness: 2,
      color: red,
    });
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/modules/receipts/hand-receipt.test.ts`
Expected: PASS (existing tests + the CLOSED smoke test).

- [ ] **Step 5: Commit**

```bash
git add src/modules/receipts/hand-receipt.ts src/modules/receipts/hand-receipt.test.ts
git commit -m "feat(returns): VOID/CLEARED PDF overlay for closed receipts"
```

---

### Task 8: Verify, migrate production, release

**Files:** none (release task).

- [ ] **Step 1: Full verification**

Run: `npm run lint && npx vitest run && npm run build`
Expected: lint clean; all vitest files green; build succeeds. Fix anything red before proceeding.

- [ ] **Step 2: Apply the migration to production Supabase BEFORE pushing**

Using the prod `DATABASE_URL` from `.env.production.local` (do NOT print secrets), run `prisma migrate deploy` against production (the same mechanism used for the `import_batch` migration). Confirm output reports the `property_returns` migration applied. This must happen before the push so the deployed build matches the schema.

- [ ] **Step 3: Set the desk CC env var (optional, non-blocking)**

If the G6 shared inbox is known, add `G6_SERVICE_DESK_EMAIL` to Vercel production (`npx vercel env add G6_SERVICE_DESK_EMAIL production`). If not set, returns still work and simply send only to the customer (no CC).

- [ ] **Step 4: Push**

```bash
git push origin feat/hand-receipt-app
```

- [ ] **Step 5: Verify live**

After the Vercel deploy completes, confirm the receipt page still returns 200 for an existing receipt and `/receipts/<HR>/return` returns a redirect/200 behind the admin gate. Record the result.

- [ ] **Step 6: Update the ledger**

Append a "SHIPPED" entry to `.superpowers/sdd/progress.md` noting the range and that the `property_returns` migration was applied to prod before push.

---

## Self-Review

**Spec coverage:**
- Partial return (validate, compute balance, ledger, redline, email) → Tasks 2, 3, 5, 6, 4. ✓
- Full return (verify match, zero out, lock CLOSED, ledger, VOID/CLEARED, clearance email) → Tasks 3 (auto-detect FULL + close), 7 (overlay), 4 (clearance email). ✓
- OPEN/CLOSED state + read-only when closed → Task 1 (enum/migration), Task 5 (return page redirects if not OPEN), Task 6 (no button + banner when closed). ✓
- Immutable ledger → Task 1 (`ReturnTransaction`), Task 3 (write-once, no update path). ✓
- Redline UI (strikethrough old, bold new) → Task 5 (result summary), Task 6 (receipt page). ✓
- VOID/CLEARED watermark + struck signature → Task 7. ✓
- Email blueprints (subjects, CC desk, AR 735-5, CLEARED banner, clearance advice) → Task 4. ✓
- Anti-blank rule → Task 5 (client `canSubmit` + server empty-selection reject). ✓
- Serial checkpoint checkbox → Task 5 (client gate + server `verified` reject). ✓
- Immutable history / corrections via new transaction → inherent (no undo path); documented in Global Constraints. ✓
- Migrate existing COMPLETED→OPEN → Task 1 Step 7 SQL. ✓

**Placeholder scan:** The only intentional placeholder is Task 7 Step 1's `baseReceiptData` fixture name, explicitly flagged to match the existing test file's fixture. No TBD/TODO/"handle edge cases" left.

**Type consistency:** `HeldItem`, `ReturnPlan`, `ReturnLineBalance` defined in Task 2 and consumed unchanged in Tasks 3/4/5. `processReturn` result shape (`{ plan, receiptNumber, receiver }`) matches what Task 5's action consumes. `ReturnEmailArgs` fields match the action's call site. Status strings are `"OPEN"`/`"CLOSED"` everywhere. `ReturnKind` is `"PARTIAL"`/`"FULL"` everywhere.
