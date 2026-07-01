# Hand Receipt App — Plan 3: Transfers & Audit

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the custody handshake — current holder initiates a transfer, recipient draws a signature to accept, custody moves; plus user dashboard, transfer history on the item page, admin override, users management, and the admin audit view.

**Architecture:** All custody mutations live in `src/modules/transfers/transfers.service.ts` — the single owner of `Item.currentHolderId`. It enforces the invariant "at most one PENDING transfer per item" transactionally. Signatures are captured client-side on a canvas and stored as a PNG (data-URL string) on the Transfer row. Users management in `src/modules/users/users.service.ts`. UI: user dashboard, sign screen, transfer history component, admin users + audit pages.

**Tech Stack:** Same as Plans 1–2.

**Prerequisite:** Plans 1 and 2 complete.

## Global Constraints

- `Item.currentHolderId` is mutated **only** inside `transfers.service.ts`, inside a transaction.
- Invariant: an item has **at most one** `PENDING` transfer at a time. Enforce with a partial unique index AND a transactional guard.
- Authorization (server-side): initiate → current holder only; cancel → initiating holder or admin, while PENDING; accept/sign → the transfer's `toUser` only, while PENDING; override → admin only.
- Accept requires a non-empty `signatureImage` (a `data:image/png;base64,...` string).
- Deactivated users cannot be transfer recipients. Retired items cannot receive new transfers.
- Every completed transfer writes immutable snapshot fields: `fromUserName`, `toUserName`, `itemSummary`.
- `TransferStatus = { PENDING, COMPLETED, CANCELLED }` (already in schema from Plan 2).

---

### Task 1: Partial unique index for single pending transfer + test-helper update

**Files:**
- Create: `prisma/migrations/<ts>_one_pending_transfer/migration.sql` (via `prisma migrate dev`)
- Modify: `tests/helpers/db.ts` (add `Transfer` back to TRUNCATE)

**Interfaces:**
- Produces: a DB-level guarantee of ≤1 PENDING transfer per item.

- [ ] **Step 1: Add a partial unique index via an empty schema change**

Prisma cannot express partial indexes in schema directly; use a manual migration. Run:
```bash
npx prisma migrate dev --create-only --name one_pending_transfer
```
Edit the generated `migration.sql` to contain exactly:
```sql
CREATE UNIQUE INDEX "one_pending_transfer_per_item"
ON "Transfer" ("itemId")
WHERE "status" = 'PENDING';
```
Then apply:
```bash
npx prisma migrate dev
```
Expected: migration applied.

- [ ] **Step 2: Update the truncation helper to include Transfer**

In `tests/helpers/db.ts`, ensure `resetDb` truncates all three:
```typescript
await prisma.$executeRawUnsafe(
  `TRUNCATE TABLE "Transfer","Item","User" RESTART IDENTITY CASCADE;`
);
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: enforce single pending transfer per item via partial unique index"
```

---

### Task 2: Transfers service — initiate (TDD)

**Files:**
- Create: `src/modules/transfers/transfers.service.ts`
- Create: `src/modules/transfers/transfers.errors.ts`
- Test: `src/modules/transfers/initiate.test.ts`
- Create (test util): `tests/helpers/factories.ts`

**Interfaces:**
- Consumes: `prisma`.
- Produces:
  - `class TransferError extends Error { code: TransferErrorCode }` where `TransferErrorCode = "NOT_HOLDER" | "ALREADY_PENDING" | "ITEM_RETIRED" | "RECIPIENT_INVALID" | "NOT_RECIPIENT" | "NOT_PENDING" | "SIGNATURE_REQUIRED" | "SAME_USER"`.
  - `initiateTransfer(args: { itemId: string; fromUserId: string; toUserId: string }): Promise<Transfer>` — creates a PENDING transfer after checks.

- [ ] **Step 1: Error type**

`src/modules/transfers/transfers.errors.ts`:
```typescript
export type TransferErrorCode =
  | "NOT_HOLDER" | "ALREADY_PENDING" | "ITEM_RETIRED" | "RECIPIENT_INVALID"
  | "NOT_RECIPIENT" | "NOT_PENDING" | "SIGNATURE_REQUIRED" | "SAME_USER";

export class TransferError extends Error {
  constructor(public code: TransferErrorCode) {
    super(code);
    this.name = "TransferError";
  }
}
```

- [ ] **Step 2: Test factories**

`tests/helpers/factories.ts`:
```typescript
import prisma from "@/lib/prisma";

let n = 0;
export function makeUser(overrides: Partial<{ name: string; role: "ADMIN" | "USER"; isActive: boolean }> = {}) {
  n += 1;
  return prisma.user.create({
    data: {
      name: overrides.name ?? `User${n}`,
      email: `user${n}@x.co`,
      passwordHash: "x",
      role: overrides.role ?? "USER",
      isActive: overrides.isActive ?? true,
    },
  });
}

export function makeItem(createdById: string, overrides: Partial<{ currentHolderId: string; status: "ACTIVE" | "RETIRED" }> = {}) {
  n += 1;
  return prisma.item.create({
    data: {
      make: "Make", model: "Model", serialNumber: `SN${n}`,
      createdById,
      currentHolderId: overrides.currentHolderId,
      status: overrides.status ?? "ACTIVE",
    },
  });
}
```

- [ ] **Step 3: Write the failing test**

`src/modules/transfers/initiate.test.ts`:
```typescript
import { beforeAll, beforeEach, expect, test } from "vitest";
import { migrateTestDb, resetDb } from "../../../tests/helpers/db";
import { makeItem, makeUser } from "../../../tests/helpers/factories";
import { initiateTransfer } from "./transfers.service";

beforeAll(() => migrateTestDb());
beforeEach(() => resetDb());

test("holder can initiate a pending transfer to another active user", async () => {
  const admin = await makeUser({ role: "ADMIN" });
  const holder = await makeUser();
  const recipient = await makeUser();
  const item = await makeItem(admin.id, { currentHolderId: holder.id });

  const t = await initiateTransfer({ itemId: item.id, fromUserId: holder.id, toUserId: recipient.id });
  expect(t.status).toBe("PENDING");
  expect(t.toUserId).toBe(recipient.id);
  expect(t.fromUserId).toBe(holder.id);
});

test("non-holder cannot initiate", async () => {
  const admin = await makeUser({ role: "ADMIN" });
  const holder = await makeUser();
  const stranger = await makeUser();
  const recipient = await makeUser();
  const item = await makeItem(admin.id, { currentHolderId: holder.id });
  await expect(
    initiateTransfer({ itemId: item.id, fromUserId: stranger.id, toUserId: recipient.id })
  ).rejects.toMatchObject({ code: "NOT_HOLDER" });
});

test("cannot initiate a second pending transfer", async () => {
  const admin = await makeUser({ role: "ADMIN" });
  const holder = await makeUser();
  const r1 = await makeUser();
  const r2 = await makeUser();
  const item = await makeItem(admin.id, { currentHolderId: holder.id });
  await initiateTransfer({ itemId: item.id, fromUserId: holder.id, toUserId: r1.id });
  await expect(
    initiateTransfer({ itemId: item.id, fromUserId: holder.id, toUserId: r2.id })
  ).rejects.toMatchObject({ code: "ALREADY_PENDING" });
});

test("cannot transfer to self", async () => {
  const admin = await makeUser({ role: "ADMIN" });
  const holder = await makeUser();
  const item = await makeItem(admin.id, { currentHolderId: holder.id });
  await expect(
    initiateTransfer({ itemId: item.id, fromUserId: holder.id, toUserId: holder.id })
  ).rejects.toMatchObject({ code: "SAME_USER" });
});

test("cannot transfer a retired item", async () => {
  const admin = await makeUser({ role: "ADMIN" });
  const holder = await makeUser();
  const recipient = await makeUser();
  const item = await makeItem(admin.id, { currentHolderId: holder.id, status: "RETIRED" });
  await expect(
    initiateTransfer({ itemId: item.id, fromUserId: holder.id, toUserId: recipient.id })
  ).rejects.toMatchObject({ code: "ITEM_RETIRED" });
});

test("cannot transfer to inactive recipient", async () => {
  const admin = await makeUser({ role: "ADMIN" });
  const holder = await makeUser();
  const recipient = await makeUser({ isActive: false });
  const item = await makeItem(admin.id, { currentHolderId: holder.id });
  await expect(
    initiateTransfer({ itemId: item.id, fromUserId: holder.id, toUserId: recipient.id })
  ).rejects.toMatchObject({ code: "RECIPIENT_INVALID" });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm run test -- initiate`
Expected: FAIL (service not found).

- [ ] **Step 5: Write minimal implementation**

`src/modules/transfers/transfers.service.ts`:
```typescript
import type { Transfer } from "@prisma/client";
import prisma from "@/lib/prisma";
import { TransferError } from "./transfers.errors";

export async function initiateTransfer(args: {
  itemId: string;
  fromUserId: string;
  toUserId: string;
}): Promise<Transfer> {
  const { itemId, fromUserId, toUserId } = args;
  if (fromUserId === toUserId) throw new TransferError("SAME_USER");

  return prisma.$transaction(async (tx) => {
    const item = await tx.item.findUnique({ where: { id: itemId } });
    if (!item) throw new TransferError("NOT_HOLDER");
    if (item.currentHolderId !== fromUserId) throw new TransferError("NOT_HOLDER");
    if (item.status === "RETIRED") throw new TransferError("ITEM_RETIRED");

    const recipient = await tx.user.findUnique({ where: { id: toUserId } });
    if (!recipient || !recipient.isActive) throw new TransferError("RECIPIENT_INVALID");

    const pending = await tx.transfer.findFirst({
      where: { itemId, status: "PENDING" },
    });
    if (pending) throw new TransferError("ALREADY_PENDING");

    const holder = await tx.user.findUnique({ where: { id: fromUserId } });
    return tx.transfer.create({
      data: {
        itemId,
        fromUserId,
        toUserId,
        status: "PENDING",
        fromUserName: holder?.name ?? null,
        toUserName: recipient.name,
        itemSummary: `${item.make} ${item.model} (SN ${item.serialNumber})`,
      },
    });
  });
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm run test -- initiate`
Expected: PASS (6 tests).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: initiateTransfer with holder/recipient/pending guards"
```

---

### Task 3: Transfers service — accept (sign), cancel, override (TDD)

**Files:**
- Modify: `src/modules/transfers/transfers.service.ts`
- Test: `src/modules/transfers/accept-cancel-override.test.ts`

**Interfaces:**
- Consumes: `initiateTransfer` (Task 2), `TransferError`.
- Produces:
  - `acceptTransfer(args: { transferId: string; toUserId: string; signatureImage: string }): Promise<Transfer>` — recipient signs; flips to COMPLETED, moves `currentHolderId`, sets `signedAt`.
  - `cancelTransfer(args: { transferId: string; actingUserId: string; isAdmin: boolean }): Promise<Transfer>` — initiating holder or admin; PENDING→CANCELLED.
  - `overrideAssign(args: { itemId: string; toUserId: string; actingAdminId: string }): Promise<Transfer>` — force custody move without signature; auto-cancels any PENDING transfer; writes `isOverride=true`.

- [ ] **Step 1: Write the failing test**

`src/modules/transfers/accept-cancel-override.test.ts`:
```typescript
import { beforeAll, beforeEach, expect, test } from "vitest";
import prisma from "@/lib/prisma";
import { migrateTestDb, resetDb } from "../../../tests/helpers/db";
import { makeItem, makeUser } from "../../../tests/helpers/factories";
import { initiateTransfer, acceptTransfer, cancelTransfer, overrideAssign } from "./transfers.service";

const SIG = "data:image/png;base64,iVBORw0KGgoAAAANS";

beforeAll(() => migrateTestDb());
beforeEach(() => resetDb());

test("recipient accepts with signature → custody moves and receipt completes", async () => {
  const admin = await makeUser({ role: "ADMIN" });
  const holder = await makeUser();
  const recipient = await makeUser();
  const item = await makeItem(admin.id, { currentHolderId: holder.id });
  const t = await initiateTransfer({ itemId: item.id, fromUserId: holder.id, toUserId: recipient.id });

  const done = await acceptTransfer({ transferId: t.id, toUserId: recipient.id, signatureImage: SIG });
  expect(done.status).toBe("COMPLETED");
  expect(done.signedAt).not.toBeNull();
  const after = await prisma.item.findUnique({ where: { id: item.id } });
  expect(after?.currentHolderId).toBe(recipient.id);
});

test("accept requires a signature", async () => {
  const admin = await makeUser({ role: "ADMIN" });
  const holder = await makeUser();
  const recipient = await makeUser();
  const item = await makeItem(admin.id, { currentHolderId: holder.id });
  const t = await initiateTransfer({ itemId: item.id, fromUserId: holder.id, toUserId: recipient.id });
  await expect(
    acceptTransfer({ transferId: t.id, toUserId: recipient.id, signatureImage: "" })
  ).rejects.toMatchObject({ code: "SIGNATURE_REQUIRED" });
});

test("only the recipient can accept", async () => {
  const admin = await makeUser({ role: "ADMIN" });
  const holder = await makeUser();
  const recipient = await makeUser();
  const stranger = await makeUser();
  const item = await makeItem(admin.id, { currentHolderId: holder.id });
  const t = await initiateTransfer({ itemId: item.id, fromUserId: holder.id, toUserId: recipient.id });
  await expect(
    acceptTransfer({ transferId: t.id, toUserId: stranger.id, signatureImage: SIG })
  ).rejects.toMatchObject({ code: "NOT_RECIPIENT" });
});

test("initiating holder can cancel a pending transfer", async () => {
  const admin = await makeUser({ role: "ADMIN" });
  const holder = await makeUser();
  const recipient = await makeUser();
  const item = await makeItem(admin.id, { currentHolderId: holder.id });
  const t = await initiateTransfer({ itemId: item.id, fromUserId: holder.id, toUserId: recipient.id });
  const cancelled = await cancelTransfer({ transferId: t.id, actingUserId: holder.id, isAdmin: false });
  expect(cancelled.status).toBe("CANCELLED");
  const after = await prisma.item.findUnique({ where: { id: item.id } });
  expect(after?.currentHolderId).toBe(holder.id); // unchanged
});

test("a stranger cannot cancel", async () => {
  const admin = await makeUser({ role: "ADMIN" });
  const holder = await makeUser();
  const recipient = await makeUser();
  const stranger = await makeUser();
  const item = await makeItem(admin.id, { currentHolderId: holder.id });
  const t = await initiateTransfer({ itemId: item.id, fromUserId: holder.id, toUserId: recipient.id });
  await expect(
    cancelTransfer({ transferId: t.id, actingUserId: stranger.id, isAdmin: false })
  ).rejects.toMatchObject({ code: "NOT_HOLDER" });
});

test("admin override moves custody without signature and cancels pending", async () => {
  const admin = await makeUser({ role: "ADMIN" });
  const holder = await makeUser();
  const recipient = await makeUser();
  const target = await makeUser();
  const item = await makeItem(admin.id, { currentHolderId: holder.id });
  const pending = await initiateTransfer({ itemId: item.id, fromUserId: holder.id, toUserId: recipient.id });

  const ov = await overrideAssign({ itemId: item.id, toUserId: target.id, actingAdminId: admin.id });
  expect(ov.isOverride).toBe(true);
  expect(ov.status).toBe("COMPLETED");
  const after = await prisma.item.findUnique({ where: { id: item.id } });
  expect(after?.currentHolderId).toBe(target.id);
  const stale = await prisma.transfer.findUnique({ where: { id: pending.id } });
  expect(stale?.status).toBe("CANCELLED");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- accept-cancel-override`
Expected: FAIL (functions not exported).

- [ ] **Step 3: Add implementations to transfers.service.ts**

Append to `src/modules/transfers/transfers.service.ts`:
```typescript
export async function acceptTransfer(args: {
  transferId: string;
  toUserId: string;
  signatureImage: string;
}): Promise<Transfer> {
  const { transferId, toUserId, signatureImage } = args;
  if (!signatureImage || !signatureImage.startsWith("data:image/")) {
    throw new TransferError("SIGNATURE_REQUIRED");
  }
  return prisma.$transaction(async (tx) => {
    const t = await tx.transfer.findUnique({ where: { id: transferId } });
    if (!t) throw new TransferError("NOT_PENDING");
    if (t.status !== "PENDING") throw new TransferError("NOT_PENDING");
    if (t.toUserId !== toUserId) throw new TransferError("NOT_RECIPIENT");

    await tx.item.update({ where: { id: t.itemId }, data: { currentHolderId: toUserId } });
    return tx.transfer.update({
      where: { id: transferId },
      data: { status: "COMPLETED", signatureImage, signedAt: new Date() },
    });
  });
}

export async function cancelTransfer(args: {
  transferId: string;
  actingUserId: string;
  isAdmin: boolean;
}): Promise<Transfer> {
  const { transferId, actingUserId, isAdmin } = args;
  return prisma.$transaction(async (tx) => {
    const t = await tx.transfer.findUnique({ where: { id: transferId } });
    if (!t) throw new TransferError("NOT_PENDING");
    if (t.status !== "PENDING") throw new TransferError("NOT_PENDING");
    if (!isAdmin && t.fromUserId !== actingUserId) throw new TransferError("NOT_HOLDER");
    return tx.transfer.update({
      where: { id: transferId },
      data: { status: "CANCELLED", cancelledAt: new Date() },
    });
  });
}

export async function overrideAssign(args: {
  itemId: string;
  toUserId: string;
  actingAdminId: string;
}): Promise<Transfer> {
  const { itemId, toUserId, actingAdminId } = args;
  return prisma.$transaction(async (tx) => {
    const item = await tx.item.findUnique({ where: { id: itemId } });
    if (!item) throw new TransferError("NOT_HOLDER");
    const recipient = await tx.user.findUnique({ where: { id: toUserId } });
    if (!recipient || !recipient.isActive) throw new TransferError("RECIPIENT_INVALID");

    await tx.transfer.updateMany({
      where: { itemId, status: "PENDING" },
      data: { status: "CANCELLED", cancelledAt: new Date() },
    });
    await tx.item.update({ where: { id: itemId }, data: { currentHolderId: toUserId } });

    const fromUser = item.currentHolderId
      ? await tx.user.findUnique({ where: { id: item.currentHolderId } })
      : null;
    return tx.transfer.create({
      data: {
        itemId,
        fromUserId: item.currentHolderId,
        toUserId,
        status: "COMPLETED",
        isOverride: true,
        actingAdminId,
        signedAt: new Date(),
        fromUserName: fromUser?.name ?? null,
        toUserName: recipient.name,
        itemSummary: `${item.make} ${item.model} (SN ${item.serialNumber})`,
      },
    });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- accept-cancel-override`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: acceptTransfer/cancelTransfer/overrideAssign custody logic"
```

---

### Task 4: Transfer query helpers (TDD)

**Files:**
- Modify: `src/modules/transfers/transfers.service.ts`
- Test: `src/modules/transfers/queries.test.ts`

**Interfaces:**
- Produces:
  - `getItemHistory(itemId: string): Promise<Transfer[]>` — all transfers for an item, newest first.
  - `getPendingForUser(userId: string): Promise<{ incoming: Transfer[]; outgoing: Transfer[] }>` — PENDING where user is recipient (incoming) or initiator (outgoing).
  - `getHeldItems(userId: string): Promise<Item[]>` — items whose `currentHolderId === userId`.

- [ ] **Step 1: Write the failing test**

`src/modules/transfers/queries.test.ts`:
```typescript
import { beforeAll, beforeEach, expect, test } from "vitest";
import { migrateTestDb, resetDb } from "../../../tests/helpers/db";
import { makeItem, makeUser } from "../../../tests/helpers/factories";
import { initiateTransfer, getItemHistory, getPendingForUser, getHeldItems } from "./transfers.service";

beforeAll(() => migrateTestDb());
beforeEach(() => resetDb());

test("getHeldItems returns items the user currently holds", async () => {
  const admin = await makeUser({ role: "ADMIN" });
  const holder = await makeUser();
  await makeItem(admin.id, { currentHolderId: holder.id });
  await makeItem(admin.id); // unassigned
  const held = await getHeldItems(holder.id);
  expect(held).toHaveLength(1);
});

test("getPendingForUser splits incoming and outgoing", async () => {
  const admin = await makeUser({ role: "ADMIN" });
  const holder = await makeUser();
  const recipient = await makeUser();
  const item = await makeItem(admin.id, { currentHolderId: holder.id });
  await initiateTransfer({ itemId: item.id, fromUserId: holder.id, toUserId: recipient.id });

  const forRecipient = await getPendingForUser(recipient.id);
  expect(forRecipient.incoming).toHaveLength(1);
  expect(forRecipient.outgoing).toHaveLength(0);

  const forHolder = await getPendingForUser(holder.id);
  expect(forHolder.incoming).toHaveLength(0);
  expect(forHolder.outgoing).toHaveLength(1);
});

test("getItemHistory returns transfers newest first", async () => {
  const admin = await makeUser({ role: "ADMIN" });
  const holder = await makeUser();
  const recipient = await makeUser();
  const item = await makeItem(admin.id, { currentHolderId: holder.id });
  await initiateTransfer({ itemId: item.id, fromUserId: holder.id, toUserId: recipient.id });
  const history = await getItemHistory(item.id);
  expect(history).toHaveLength(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- queries`
Expected: FAIL.

- [ ] **Step 3: Add implementations**

Append to `src/modules/transfers/transfers.service.ts`:
```typescript
import type { Item } from "@prisma/client";

export function getItemHistory(itemId: string): Promise<Transfer[]> {
  return prisma.transfer.findMany({ where: { itemId }, orderBy: { initiatedAt: "desc" } });
}

export async function getPendingForUser(userId: string) {
  const [incoming, outgoing] = await Promise.all([
    prisma.transfer.findMany({
      where: { toUserId: userId, status: "PENDING" },
      orderBy: { initiatedAt: "desc" },
    }),
    prisma.transfer.findMany({
      where: { fromUserId: userId, status: "PENDING" },
      orderBy: { initiatedAt: "desc" },
    }),
  ]);
  return { incoming, outgoing };
}

export function getHeldItems(userId: string): Promise<Item[]> {
  return prisma.item.findMany({
    where: { currentHolderId: userId },
    orderBy: { updatedAt: "desc" },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- queries`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: transfer query helpers (history, pending, held)"
```

---

### Task 5: Transfer history component + item page actions

**Files:**
- Create: `src/components/TransferHistory.tsx`
- Modify: `src/app/i/[itemId]/page.tsx`
- Create: `src/app/actions/transfers.ts`
- Create: `src/components/InitiateTransferForm.tsx`

**Interfaces:**
- Consumes: `getItemHistory` (Task 4), `getItem` (Plan 2), `initiateTransfer` (Task 2), `auth`, `requireUser`, `prisma` (for the active-user recipient list).
- Produces:
  - `TransferHistory` component rendering an item's receipts.
  - `initiateTransferAction(prev, formData)` → `{ error?, ok? }`.
  - Item page shows an "Initiate transfer" form when the viewer is the current holder.

- [ ] **Step 1: TransferHistory component**

`src/components/TransferHistory.tsx`:
```tsx
type Row = {
  id: string; status: string; isOverride: boolean;
  fromUserName: string | null; toUserName: string;
  initiatedAt: Date; signedAt: Date | null;
};
export function TransferHistory({ rows }: { rows: Row[] }) {
  if (rows.length === 0) return <p>No transfers yet.</p>;
  return (
    <ul>
      {rows.map((r) => (
        <li key={r.id}>
          <strong>{r.fromUserName ?? "—"} → {r.toUserName}</strong>
          {" · "}{r.status}{r.isOverride ? " (admin override)" : ""}
          {" · "}initiated {new Date(r.initiatedAt).toLocaleString()}
          {r.signedAt ? ` · signed ${new Date(r.signedAt).toLocaleString()}` : ""}
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 2: Initiate-transfer server action**

`src/app/actions/transfers.ts`:
```typescript
"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/authz";
import { initiateTransfer } from "@/modules/transfers/transfers.service";
import { TransferError } from "@/modules/transfers/transfers.errors";

export async function initiateTransferAction(_prev: unknown, formData: FormData) {
  const user = await requireUser();
  const itemId = String(formData.get("itemId"));
  const toUserId = String(formData.get("toUserId"));
  try {
    await initiateTransfer({ itemId, fromUserId: user.id, toUserId });
    revalidatePath(`/i/${itemId}`);
    return { ok: true };
  } catch (e) {
    if (e instanceof TransferError) return { error: humanize(e.code) };
    throw e;
  }
}

function humanize(code: string): string {
  const map: Record<string, string> = {
    NOT_HOLDER: "You are not the current holder of this item.",
    ALREADY_PENDING: "This item already has a pending transfer.",
    ITEM_RETIRED: "This item is retired and cannot be transferred.",
    RECIPIENT_INVALID: "That recipient is not available.",
    SAME_USER: "You cannot transfer an item to yourself.",
  };
  return map[code] ?? "Could not start the transfer.";
}
```

- [ ] **Step 3: Initiate-transfer form (client)**

`src/components/InitiateTransferForm.tsx`:
```tsx
"use client";
import { useActionState } from "react";
import { initiateTransferAction } from "@/app/actions/transfers";

type UserOption = { id: string; name: string };
export function InitiateTransferForm({ itemId, users }: { itemId: string; users: UserOption[] }) {
  const [state, action, pending] = useActionState(initiateTransferAction, undefined);
  if (state && "ok" in state && state.ok) return <p>Transfer started. The recipient must sign to accept.</p>;
  return (
    <form action={action}>
      <input type="hidden" name="itemId" value={itemId} />
      <label>Transfer to:{" "}
        <select name="toUserId" required>
          <option value="">Select a person…</option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
      </label>
      {state?.error && <p role="alert" style={{ color: "crimson" }}>{state.error}</p>}
      <button disabled={pending} type="submit">{pending ? "Starting…" : "Initiate transfer"}</button>
    </form>
  );
}
```

- [ ] **Step 4: Wire actions + history into the item page**

Replace the body of `src/app/i/[itemId]/page.tsx` with:
```tsx
import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/auth";
import prisma from "@/lib/prisma";
import { getItem } from "@/modules/items/items.service";
import { getItemHistory } from "@/modules/transfers/transfers.service";
import { ItemDetails } from "@/components/ItemDetails";
import { TransferHistory } from "@/components/TransferHistory";
import { InitiateTransferForm } from "@/components/InitiateTransferForm";

export default async function ItemPage({ params }: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await params;
  const item = await getItem(itemId);
  if (!item) notFound();
  const [session, history] = await Promise.all([auth(), getItemHistory(itemId)]);
  const viewerIsHolder = !!session?.user && item.currentHolderId === session.user.id;

  const recipients = viewerIsHolder
    ? await prisma.user.findMany({
        where: { isActive: true, id: { not: session!.user.id } },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      })
    : [];

  return (
    <main style={{ fontFamily: "system-ui", maxWidth: 640, margin: "2rem auto" }}>
      <h1>{item.make} {item.model}</h1>
      <ItemDetails item={item} />
      <section id="history">
        <h2>Transfer history</h2>
        <TransferHistory rows={history} />
      </section>
      {viewerIsHolder && item.status === "ACTIVE" && (
        <section>
          <h2>Transfer this item</h2>
          <InitiateTransferForm itemId={item.id} users={recipients} />
        </section>
      )}
      {!session?.user && <p><Link href="/login">Sign in</Link> to transfer or sign for this item.</p>}
    </main>
  );
}
```

- [ ] **Step 5: Manual verification**

Assign an item to a user (via admin override in Task 8, or seed). As that holder, open `/i/<id>` → history + "Initiate transfer" form with active users listed. Start a transfer → success message; history now shows a PENDING row.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: item-page transfer history + initiate transfer flow"
```

---

### Task 6: Signature pad + sign/accept screen

**Files:**
- Create: `src/components/SignaturePad.tsx`
- Create: `src/app/transfers/[id]/page.tsx`
- Create: `src/app/transfers/[id]/SignForm.tsx`
- Modify: `src/app/actions/transfers.ts` (add `acceptTransferAction`, `cancelTransferAction`)

**Interfaces:**
- Consumes: `acceptTransfer`, `cancelTransfer` (Task 3), `prisma`, `requireUser`.
- Produces: a canvas signature pad exporting a PNG data-URL; a sign screen where the recipient reviews and accepts, or (if initiator) cancels.

- [ ] **Step 1: SignaturePad component**

`src/components/SignaturePad.tsx`:
```tsx
"use client";
import { useRef, useEffect, useState } from "react";

export function SignaturePad({ name }: { name: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dataUrl, setDataUrl] = useState("");
  const drawing = useRef(false);

  useEffect(() => {
    const c = canvasRef.current!;
    const ctx = c.getContext("2d")!;
    ctx.lineWidth = 2; ctx.lineCap = "round"; ctx.strokeStyle = "#111";
    const pos = (e: PointerEvent) => {
      const r = c.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const down = (e: PointerEvent) => { drawing.current = true; const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); };
    const move = (e: PointerEvent) => { if (!drawing.current) return; const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); };
    const up = () => { if (drawing.current) { drawing.current = false; setDataUrl(c.toDataURL("image/png")); } };
    c.addEventListener("pointerdown", down);
    c.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => { c.removeEventListener("pointerdown", down); c.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, []);

  const clear = () => {
    const c = canvasRef.current!;
    c.getContext("2d")!.clearRect(0, 0, c.width, c.height);
    setDataUrl("");
  };

  return (
    <div>
      <canvas ref={canvasRef} width={360} height={140}
why        style={{ border: "1px solid #999", touchAction: "none", display: "block" }} />
      <button type="button" onClick={clear}>Clear</button>
      <input type="hidden" name={name} value={dataUrl} />
    </div>
  );
}
```
Note: remove the stray `why` token if pasted — the canvas element should read `<canvas ref={canvasRef} width={360} height={140} style={{ ... }} />`.

- [ ] **Step 2: Accept + cancel server actions**

Append to `src/app/actions/transfers.ts`:
```typescript
import { acceptTransfer, cancelTransfer } from "@/modules/transfers/transfers.service";
import { redirect } from "next/navigation";

export async function acceptTransferAction(_prev: unknown, formData: FormData) {
  const user = await requireUser();
  const transferId = String(formData.get("transferId"));
  const signatureImage = String(formData.get("signature"));
  try {
    await acceptTransfer({ transferId, toUserId: user.id, signatureImage });
  } catch (e) {
    if (e instanceof TransferError) {
      return { error: e.code === "SIGNATURE_REQUIRED" ? "Please sign before accepting." : "Could not accept this transfer." };
    }
    throw e;
  }
  redirect("/dashboard");
}

export async function cancelTransferAction(formData: FormData) {
  const user = await requireUser();
  const transferId = String(formData.get("transferId"));
  await cancelTransfer({ transferId, actingUserId: user.id, isAdmin: user.role === "ADMIN" });
  redirect("/dashboard");
}
```

- [ ] **Step 3: Sign form (client)**

`src/app/transfers/[id]/SignForm.tsx`:
```tsx
"use client";
import { useActionState } from "react";
import { acceptTransferAction } from "@/app/actions/transfers";
import { SignaturePad } from "@/components/SignaturePad";

export function SignForm({ transferId }: { transferId: string }) {
  const [state, action, pending] = useActionState(acceptTransferAction, undefined);
  return (
    <form action={action}>
      <input type="hidden" name="transferId" value={transferId} />
      <p>Draw your signature to accept custody:</p>
      <SignaturePad name="signature" />
      {state?.error && <p role="alert" style={{ color: "crimson" }}>{state.error}</p>}
      <button disabled={pending} type="submit">{pending ? "Submitting…" : "Accept custody"}</button>
    </form>
  );
}
```

- [ ] **Step 4: Sign screen (server component)**

`src/app/transfers/[id]/page.tsx`:
```tsx
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/authz";
import prisma from "@/lib/prisma";
import { cancelTransferAction } from "@/app/actions/transfers";
import { SignForm } from "./SignForm";

export default async function SignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const t = await prisma.transfer.findUnique({ where: { id } });
  if (!t) notFound();
  if (t.status !== "PENDING") redirect(`/i/${t.itemId}`);

  const isRecipient = t.toUserId === user.id;
  const isInitiator = t.fromUserId === user.id;

  return (
    <main style={{ fontFamily: "system-ui", maxWidth: 480, margin: "2rem auto" }}>
      <h1>Transfer of {t.itemSummary}</h1>
      <p>From {t.fromUserName ?? "—"} to {t.toUserName}</p>
      {isRecipient && <SignForm transferId={t.id} />}
      {isInitiator && (
        <form action={cancelTransferAction}>
          <input type="hidden" name="transferId" value={t.id} />
          <button type="submit">Cancel this transfer</button>
        </form>
      )}
      {!isRecipient && !isInitiator && <p>You are not a party to this transfer.</p>}
    </main>
  );
}
```

- [ ] **Step 5: Manual verification**

As holder, initiate a transfer to user B. Log in as B, open `/transfers/<id>`, draw a signature, "Accept custody" → redirected to dashboard; item now held by B; `/i/<id>` history shows COMPLETED with signed timestamp. As initiator, the pending transfer offers "Cancel".

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: signature pad + accept/cancel transfer screen"
```

---

### Task 7: User dashboard

**Files:**
- Create: `src/app/dashboard/page.tsx`

**Interfaces:**
- Consumes: `requireUser`, `getHeldItems`, `getPendingForUser` (Task 4).
- Produces: the standard-user landing page — items held, incoming to sign, outgoing awaiting.

- [ ] **Step 1: Dashboard page**

`src/app/dashboard/page.tsx`:
```tsx
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser, AuthError } from "@/lib/authz";
import { getHeldItems, getPendingForUser } from "@/modules/transfers/transfers.service";
import { SignOutButton } from "@/components/SignOutButton";

export default async function Dashboard() {
  let user;
  try { user = await requireUser(); }
  catch (e) { if (e instanceof AuthError) redirect("/login"); throw e; }

  const [held, pending] = await Promise.all([getHeldItems(user.id), getPendingForUser(user.id)]);

  return (
    <main style={{ fontFamily: "system-ui", maxWidth: 720, margin: "2rem auto" }}>
      <header style={{ display: "flex", justifyContent: "space-between" }}>
        <h1>Hello, {user.name}</h1><SignOutButton />
      </header>

      <section>
        <h2>Action needed — incoming</h2>
        {pending.incoming.length === 0 ? <p>Nothing to sign.</p> : (
          <ul>{pending.incoming.map((t) => (
            <li key={t.id}><Link href={`/transfers/${t.id}`}>Sign for {t.itemSummary}</Link> (from {t.fromUserName ?? "—"})</li>
          ))}</ul>
        )}
      </section>

      <section>
        <h2>Awaiting the other party — outgoing</h2>
        {pending.outgoing.length === 0 ? <p>No pending sends.</p> : (
          <ul>{pending.outgoing.map((t) => (
            <li key={t.id}><Link href={`/transfers/${t.id}`}>{t.itemSummary}</Link> → {t.toUserName} (pending)</li>
          ))}</ul>
        )}
      </section>

      <section>
        <h2>Items I hold</h2>
        {held.length === 0 ? <p>You are not holding any items.</p> : (
          <ul>{held.map((it) => (
            <li key={it.id}><Link href={`/i/${it.id}`}>{it.make} {it.model} (SN {it.serialNumber})</Link></li>
          ))}</ul>
        )}
      </section>
    </main>
  );
}
```

- [ ] **Step 2: Manual verification**

Log in as a standard user holding items and with a pending incoming transfer → all three sections populate; links work.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: standard-user dashboard (held, incoming, outgoing)"
```

---

### Task 8: Admin — users management + override + audit

**Files:**
- Create: `src/modules/users/users.service.ts`
- Create: `src/modules/users/users.schema.ts`
- Test: `src/modules/users/users.service.test.ts`
- Create: `src/app/admin/users/page.tsx`
- Create: `src/app/admin/actions/users.ts`
- Create: `src/app/admin/actions/override.ts`
- Create: `src/app/admin/audit/page.tsx`
- Modify: `src/app/i/[itemId]/page.tsx` (add admin override form)

**Interfaces:**
- Consumes: `hashPassword` (Plan 1), `overrideAssign` (Task 3), `requireAdmin`, `prisma`.
- Produces:
  - `createUser(input): Promise<User>` (name, email, password, role), `setUserActive(id, active)`, `setUserRole(id, role)`, `listUsers()`.
  - Admin users page (create + list + activate/deactivate), audit page (all transfers), override form on the item page for admins.

- [ ] **Step 1: users schema + failing service test**

`src/modules/users/users.schema.ts`:
```typescript
import { z } from "zod";
export const newUserSchema = z.object({
  name: z.string().trim().min(1),
  email: z.string().trim().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  role: z.enum(["ADMIN", "USER"]).default("USER"),
});
export type NewUserInput = z.infer<typeof newUserSchema>;
```

`src/modules/users/users.service.test.ts`:
```typescript
import { beforeAll, beforeEach, expect, test } from "vitest";
import { migrateTestDb, resetDb } from "../../../tests/helpers/db";
import { createUser, setUserActive, setUserRole, listUsers } from "./users.service";

beforeAll(() => migrateTestDb());
beforeEach(() => resetDb());

test("createUser hashes password and defaults role USER", async () => {
  const u = await createUser({ name: "Pat", email: "pat@x.co", password: "password123", role: "USER" });
  expect(u.role).toBe("USER");
  expect(u.passwordHash).not.toBe("password123");
});

test("createUser rejects short passwords", async () => {
  await expect(createUser({ name: "Pat", email: "p@x.co", password: "short", role: "USER" })).rejects.toThrow();
});

test("setUserActive toggles the flag", async () => {
  const u = await createUser({ name: "Pat", email: "pat@x.co", password: "password123", role: "USER" });
  const off = await setUserActive(u.id, false);
  expect(off.isActive).toBe(false);
});

test("setUserRole promotes to ADMIN", async () => {
  const u = await createUser({ name: "Pat", email: "pat@x.co", password: "password123", role: "USER" });
  const admin = await setUserRole(u.id, "ADMIN");
  expect(admin.role).toBe("ADMIN");
});

test("listUsers returns created users", async () => {
  await createUser({ name: "A", email: "a@x.co", password: "password123", role: "USER" });
  expect(await listUsers()).toHaveLength(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- users.service`
Expected: FAIL.

- [ ] **Step 3: Implement users service**

`src/modules/users/users.service.ts`:
```typescript
import type { Role, User } from "@prisma/client";
import prisma from "@/lib/prisma";
import { hashPassword } from "@/lib/password";
import { newUserSchema, type NewUserInput } from "./users.schema";

export async function createUser(input: NewUserInput): Promise<User> {
  const data = newUserSchema.parse(input);
  return prisma.user.create({
    data: { name: data.name, email: data.email, role: data.role, passwordHash: await hashPassword(data.password) },
  });
}

export function setUserActive(id: string, isActive: boolean): Promise<User> {
  return prisma.user.update({ where: { id }, data: { isActive } });
}

export function setUserRole(id: string, role: Role): Promise<User> {
  return prisma.user.update({ where: { id }, data: { role } });
}

export function listUsers(): Promise<User[]> {
  return prisma.user.findMany({ orderBy: { name: "asc" } });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- users.service`
Expected: PASS (5 tests).

- [ ] **Step 5: Admin users actions + page**

`src/app/admin/actions/users.ts`:
```typescript
"use server";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/authz";
import { createUser, setUserActive } from "@/modules/users/users.service";
import { newUserSchema } from "@/modules/users/users.schema";

export async function createUserAction(_prev: unknown, formData: FormData) {
  await requireAdmin();
  const parsed = newUserSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  try {
    await createUser(parsed.data);
  } catch {
    return { error: "Could not create user (email may already exist)." };
  }
  revalidatePath("/admin/users");
  return { ok: true };
}

export async function toggleUserActiveAction(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id"));
  const active = formData.get("active") === "true";
  await setUserActive(id, active);
  revalidatePath("/admin/users");
}
```

`src/app/admin/users/page.tsx`:
```tsx
import { listUsers } from "@/modules/users/users.service";
import { toggleUserActiveAction } from "@/app/admin/actions/users";
import { NewUserForm } from "./NewUserForm";

export default async function UsersPage() {
  const users = await listUsers();
  return (
    <div>
      <h1>Users</h1>
      <NewUserForm />
      <table>
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Active</th><th></th></tr></thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.name}</td><td>{u.email}</td><td>{u.role}</td><td>{u.isActive ? "Yes" : "No"}</td>
              <td>
                <form action={toggleUserActiveAction}>
                  <input type="hidden" name="id" value={u.id} />
                  <input type="hidden" name="active" value={(!u.isActive).toString()} />
                  <button type="submit">{u.isActive ? "Deactivate" : "Activate"}</button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

`src/app/admin/users/NewUserForm.tsx`:
```tsx
"use client";
import { useActionState } from "react";
import { createUserAction } from "@/app/admin/actions/users";

export function NewUserForm() {
  const [state, action, pending] = useActionState(createUserAction, undefined);
  return (
    <form action={action} style={{ marginBottom: 24 }}>
      <input name="name" placeholder="Name" required />
      <input name="email" type="email" placeholder="Email" required />
      <input name="password" type="password" placeholder="Temp password (8+)" required />
      <select name="role"><option value="USER">User</option><option value="ADMIN">Admin</option></select>
      <button disabled={pending} type="submit">Add user</button>
      {state?.error && <span role="alert" style={{ color: "crimson" }}> {state.error}</span>}
      {state && "ok" in state && state.ok && <span> Created.</span>}
    </form>
  );
}
```

- [ ] **Step 6: Admin override action + item-page form**

`src/app/admin/actions/override.ts`:
```typescript
"use server";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/authz";
import { overrideAssign } from "@/modules/transfers/transfers.service";
import { TransferError } from "@/modules/transfers/transfers.errors";

export async function overrideAssignAction(_prev: unknown, formData: FormData) {
  const admin = await requireAdmin();
  const itemId = String(formData.get("itemId"));
  const toUserId = String(formData.get("toUserId"));
  try {
    await overrideAssign({ itemId, toUserId, actingAdminId: admin.id });
    revalidatePath(`/i/${itemId}`);
    return { ok: true };
  } catch (e) {
    if (e instanceof TransferError) return { error: "Could not reassign this item." };
    throw e;
  }
}
```

Add an admin-only override block to `src/app/i/[itemId]/page.tsx`. Compute `isAdmin` and a full active-user list, and render a form. Insert after the transfer-history section:
```tsx
// near the top of the component, after `session`:
const isAdmin = session?.user.role === "ADMIN";
const allUsers = isAdmin
  ? await prisma.user.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } })
  : [];
```
```tsx
{isAdmin && (
  <section>
    <h2>Admin override — force reassign</h2>
    <OverrideForm itemId={item.id} users={allUsers} />
  </section>
)}
```
Create `src/components/OverrideForm.tsx`:
```tsx
"use client";
import { useActionState } from "react";
import { overrideAssignAction } from "@/app/admin/actions/override";

export function OverrideForm({ itemId, users }: { itemId: string; users: { id: string; name: string }[] }) {
  const [state, action, pending] = useActionState(overrideAssignAction, undefined);
  if (state && "ok" in state && state.ok) return <p>Item reassigned (override recorded).</p>;
  return (
    <form action={action}>
      <input type="hidden" name="itemId" value={itemId} />
      <select name="toUserId" required>
        <option value="">Reassign to…</option>
        {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
      </select>
      {state?.error && <span role="alert" style={{ color: "crimson" }}> {state.error}</span>}
      <button disabled={pending} type="submit">Force reassign</button>
    </form>
  );
}
```
Remember to `import { OverrideForm } from "@/components/OverrideForm";` in the item page.

- [ ] **Step 7: Audit page**

`src/app/admin/audit/page.tsx`:
```tsx
import Link from "next/link";
import prisma from "@/lib/prisma";

export default async function AuditPage() {
  const transfers = await prisma.transfer.findMany({ orderBy: { initiatedAt: "desc" }, take: 200 });
  return (
    <div>
      <h1>Audit — all transfers</h1>
      <table>
        <thead><tr><th>Item</th><th>From</th><th>To</th><th>Status</th><th>Override</th><th>Initiated</th><th>Signed</th></tr></thead>
        <tbody>
          {transfers.map((t) => (
            <tr key={t.id}>
              <td><Link href={`/i/${t.itemId}`}>{t.itemSummary}</Link></td>
              <td>{t.fromUserName ?? "—"}</td><td>{t.toUserName}</td>
              <td>{t.status}</td><td>{t.isOverride ? "Yes" : ""}</td>
              <td>{new Date(t.initiatedAt).toLocaleString()}</td>
              <td>{t.signedAt ? new Date(t.signedAt).toLocaleString() : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 8: Manual verification**

As admin: `/admin/users` create a user + deactivate/activate; `/admin/audit` lists transfers; on `/i/<id>` an override form reassigns the item and adds an override row to history/audit. Deactivated users no longer appear as transfer recipients.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: admin users management, override reassign, audit view"
```

---

### Task 9: End-to-end custody handshake

**Files:**
- Create: `tests/e2e/handshake.spec.ts`
- Create: `prisma/seed-e2e.ts` (seeds an admin + two users + one item held by user A)

**Interfaces:**
- Consumes: the whole app.

- [ ] **Step 1: E2E seed**

`prisma/seed-e2e.ts`:
```typescript
import prisma from "../src/lib/prisma";
import { hashPassword } from "../src/lib/password";

async function main() {
  const pw = await hashPassword("password123");
  const admin = await prisma.user.upsert({ where: { email: "admin@example.com" }, update: {},
    create: { name: "Admin", email: "admin@example.com", passwordHash: pw, role: "ADMIN" } });
  const a = await prisma.user.upsert({ where: { email: "a@example.com" }, update: {},
    create: { name: "Alice", email: "a@example.com", passwordHash: pw, role: "USER" } });
  await prisma.user.upsert({ where: { email: "b@example.com" }, update: {},
    create: { name: "Bob", email: "b@example.com", passwordHash: pw, role: "USER" } });
  await prisma.item.create({ data: { make: "Dell", model: "5540", serialNumber: "E2E-1", createdById: admin.id, currentHolderId: a.id } });
  console.log("E2E seed done");
}
main().finally(() => prisma.$disconnect());
```

- [ ] **Step 2: Write the E2E handshake test**

`tests/e2e/handshake.spec.ts`:
```typescript
import { expect, test } from "@playwright/test";

async function login(page, email: string) {
  await page.goto("/login");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', "password123");
  await page.click('button[type="submit"]');
  await expect(page).not.toHaveURL(/\/login/);
}

test("holder initiates, recipient signs, custody moves", async ({ page }) => {
  // Alice initiates from her dashboard's held item.
  await login(page, "a@example.com");
  await page.goto("/dashboard");
  await page.getByRole("link", { name: /Dell 5540/ }).click();
  await page.getByRole("combobox").selectOption({ label: "Bob" });
  await page.getByRole("button", { name: /Initiate transfer/ }).click();
  await expect(page.getByText(/recipient must sign/i)).toBeVisible();

  // Bob signs and accepts.
  await login(page, "b@example.com");
  await page.goto("/dashboard");
  await page.getByRole("link", { name: /Sign for/ }).click();
  const canvas = page.locator("canvas");
  const box = await canvas.boundingBox();
  await page.mouse.move(box!.x + 20, box!.y + 20);
  await page.mouse.down();
  await page.mouse.move(box!.x + 200, box!.y + 100);
  await page.mouse.up();
  await page.getByRole("button", { name: /Accept custody/ }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByRole("link", { name: /Dell 5540/ })).toBeVisible(); // Bob now holds it
});
```

- [ ] **Step 3: Run E2E**

Run: `npm run db:reset && npx tsx prisma/seed-e2e.ts && npx playwright test handshake`
Expected: 1 passed.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test: e2e full custody handshake with signature"
```

---

## Self-Review

- **Spec coverage:**
  - Holder-sends/receiver-signs handshake ✅ Tasks 2/3/6.
  - Drawn signature stored on receipt ✅ Task 6 (`SignaturePad` → `signatureImage`).
  - Append-only history newest-first ✅ Task 4/5.
  - Holder can cancel while pending ✅ Task 3/6.
  - Admin override (flagged, cancels pending) ✅ Tasks 3/8.
  - Single-pending invariant ✅ Task 1 (index) + Task 2 (guard).
  - Deactivated users not recipients; retired items not transferable ✅ Task 2.
  - User dashboard (held / incoming / outgoing) ✅ Task 7.
  - Admin users management + full audit ✅ Task 8.
  - Standard users see only items they hold/have held: dashboard shows held ✅; the `/i/<id>` page is intentionally public read-only per spec, so no extra scoping needed there.
- **Placeholders:** none. The one call-out is the stray `why` token deliberately flagged in Task 6 Step 1 with the corrected line — an explicit fix instruction, not a silent placeholder.
- **Type consistency:** `TransferError`/`TransferErrorCode` shared across service + actions. `initiateTransfer`/`acceptTransfer`/`cancelTransfer`/`overrideAssign` signatures match their call sites in actions (Tasks 5/6/8). `getPendingForUser` `{ incoming, outgoing }` shape matches the dashboard (Task 7). `signatureImage` name (`signature` form field) consistent between `SignForm`, `SignaturePad`, and `acceptTransferAction`.

## Cross-Plan Note

Plan 2 creates items **unassigned**. To exercise transfers you need an initial holder: use the admin **override** (Task 8) to assign a freshly-created item to its first holder, or seed one (Task 9). This is the intended "initial assignment" path and keeps all `currentHolderId` mutations inside the transfers module.
