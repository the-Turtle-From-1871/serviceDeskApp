# Item-level Service Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the receipt-level service queue with an item-level queue driven by a per-item "Needs service?" flag and service type (Reimage / Repair / Other), worked with a reversible "Mark Completed" action.

**Architecture:** Repurpose the existing `ServiceQueueItem` model to be one row per `Item` (unique `itemId`, nullable `transferId`, `serviceType`, `serviceNote`, `PENDING`/`COMPLETED` status). Capture the flag on the hand-receipt builder and on the item detail page. The `/admin/queue` page becomes a sortable/searchable/filterable/column-toggleable item table mirroring the items view.

**Tech Stack:** Next.js 16 (App Router, Server Components/Actions), React 19, Prisma 7 over PostgreSQL, Zod, Vitest (unit tests with mocked `@/lib/prisma`), TypeScript 5.

## Global Constraints

- Every Server Action / Route Handler checks auth first: `requireAdmin()` for admin ops, `requireUser()` otherwise (`src/lib/authz.ts`). Never trust input IDs beyond the schema.
- Standard Prisma methods only — no raw string concatenation in queries.
- Zod-validate all form input before use. Return generic error strings to the client; `console.error` details server-side.
- No new npm packages. If one were needed, `npm view <pkg>` first — none is needed here.
- Testing convention: `.test.ts` files run under Vitest. Service-layer tests mock `@/lib/prisma` via `vi.mock` (see `src/modules/transfers/transfers.service.test.ts`). Pure-logic and view-helper tests use no DB. Run a single file with `npx vitest run <path>`.
- **Refactor note (read before executing):** This reworks a shared model, so between **Task 1** and **Task 9** the full `npm run build` will not typecheck (consumers are updated across tasks). Each task is gated by **its own** `npx vitest run <file>` passing. Full-app green (`npm run build` + full `npx vitest run` + `npm run lint`) is restored and verified in **Task 9** and **Task 10**.
- Enum string values are load-bearing (compared as literals and persisted): `ServiceType = REIMAGE | REPAIR | OTHER`; `ServiceQueueStatus = PENDING | COMPLETED`. Copy verbatim.

---

## File Structure

**Prisma**
- Modify: `prisma/schema.prisma` — `ServiceType` enum; `ServiceQueueStatus` (`PENDING`/`COMPLETED`); item-level `ServiceQueueItem`; `Item.serviceQueueItem` back-relation; `Transfer.queueItems` relation to nullable side.
- Create: `prisma/migrations/<ts>_item_level_service_queue/migration.sql` (generated, with a row-discard prepended).

**Service-queue module** (`src/modules/service-queue/`)
- Modify: `service-queue.status.ts` (+ `service-queue.status.test.ts`) — COMPLETED logic + `serviceTypeLabel`.
- Modify: `service-queue.errors.ts` — add `NOTE_REQUIRED`.
- Modify: `service-queue.service.ts` — item-level operations.
- Create: `service-queue.service.test.ts` — mocked-prisma unit tests.
- Create: `service-form.ts` (+ `service-form.test.ts`) — pure parse of per-item form fields.
- Delete: `service-queue.enqueue.ts`, `service-queue.enqueue.test.ts`, `service-queue.group.ts`, `service-queue.group.test.ts` (receipt-level mapper + date grouping no longer used).

**Receipt intake**
- Modify: `src/app/receipts/new/page.tsx` — thread per-serial `itemId` into the builder.
- Modify: `src/app/receipts/new/ReceiptBuilderForm.tsx` — per-serial "Needs service?" UI.
- Modify: `src/app/actions/receipts.ts` — create service rows for flagged items.

**Item detail**
- Modify: `src/app/i/[itemId]/page.tsx` — Service card.
- Create: `src/app/i/[itemId]/ServiceControls.tsx` — admin flag/type/complete/reopen controls (client).
- Modify: `src/app/admin/actions/queue.ts` — item-level server actions.
- Modify: `src/modules/transfers/transfers.service.ts` — `getCurrentOpenTransferId` helper.

**Queue view**
- Create: `src/components/persisted-pref.ts` — extracted localStorage store hook.
- Modify: `src/components/ItemSelectTable.tsx` — import the extracted hook.
- Create: `src/components/service-queue-view.ts` (+ `service-queue-view.test.ts`) — columns/sort/filter/parse.
- Create: `src/components/ServiceQueueTable.tsx` — client table.
- Modify: `src/app/admin/queue/page.tsx` — item-level server page.

**Docs**
- Modify: `CLAUDE.md` — rewrite "Ingest & Routing Queue".

---

## Task 1: Prisma schema + migration (item-level `ServiceQueueItem`)

**Files:**
- Modify: `prisma/schema.prisma` (enum block ~197-205, `ServiceQueueItem` ~207-220, `Item` ~60-74, `Transfer.queueItems` ~130-132)
- Create: `prisma/migrations/<timestamp>_item_level_service_queue/migration.sql` (generated)

**Interfaces:**
- Produces: Prisma types `ServiceType` (`"REIMAGE"|"REPAIR"|"OTHER"`), `ServiceQueueStatus` (`"PENDING"|"COMPLETED"`), and model `ServiceQueueItem { id, itemId (unique), transferId (nullable), serviceType, serviceNote (nullable), status, createdAt, updatedAt }`.

- [ ] **Step 1: Replace the enums**

In `prisma/schema.prisma`, replace the existing `ServiceQueueStatus` enum (and its comments) with:

```prisma
// [Service Queue] Service requested for a queued item.
enum ServiceType {
  REIMAGE
  REPAIR
  OTHER // free-text detail in ServiceQueueItem.serviceNote
}

// [Service Queue] Lifecycle for an item's service request.
enum ServiceQueueStatus {
  // In the queue: the item needs active service/intervention.
  PENDING
  // Service done. Retained (never deleted), drops off the active queue, and can
  // be reopened (PENDING) from the item detail page.
  COMPLETED
}
```

- [ ] **Step 2: Replace the `ServiceQueueItem` model**

Replace the existing `ServiceQueueItem` model with:

```prisma
// [Service Queue] One service request per item. Present with status PENDING ==
// "needs service" (shown on the queue). The item may optionally be tied to the
// hand receipt it was flagged on (transferId), shown on the item detail page.
model ServiceQueueItem {
  id          String             @id @default(cuid())
  item        Item               @relation(fields: [itemId], references: [id], onDelete: Cascade)
  itemId      String             @unique
  transfer    Transfer?          @relation("TransferQueueItems", fields: [transferId], references: [id], onDelete: SetNull)
  transferId  String?
  serviceType ServiceType
  serviceNote String?
  status      ServiceQueueStatus @default(PENDING)
  createdAt   DateTime           @default(now())
  updatedAt   DateTime           @updatedAt

  @@index([status])
  @@index([transferId])
}
```

- [ ] **Step 3: Add the `Item` back-relation**

In `model Item`, add this line after `transferItems TransferItem[]` (line ~71):

```prisma
  serviceQueueItem ServiceQueueItem?
```

- [ ] **Step 4: Confirm the `Transfer` relation still matches**

The existing `Transfer` field stays as-is (it is the one-to-many parent; each queue row optionally points back):

```prisma
  queueItems ServiceQueueItem[] @relation("TransferQueueItems")
```

- [ ] **Step 5: Generate the migration**

Run: `npx prisma migrate dev --name item_level_service_queue --create-only`
Expected: a new folder `prisma/migrations/<ts>_item_level_service_queue/migration.sql` is created (not yet applied).

- [ ] **Step 6: Prepend a row-discard to the generated SQL**

Open the generated `migration.sql`. Because `itemId` becomes `NOT NULL UNIQUE` on a table that may hold old receipt-level rows, add this as the **first** statement so the restructure applies cleanly (the old receipt-level rows are the abandoned concept — intentionally discarded):

```sql
-- Discard old receipt-level queue rows (no item association); the queue is now item-level.
DELETE FROM "ServiceQueueItem";
```

- [ ] **Step 7: Apply and generate the client**

Run: `npx prisma migrate dev`
Then: `npx prisma generate`
Expected: migration applies without error; client regenerates. `ServiceQueueStatus` now resolves to `"PENDING" | "COMPLETED"` and `ServiceType` exists.

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(service-queue): item-level ServiceQueueItem schema + migration"
```

---

## Task 2: Pure status logic + `serviceTypeLabel`

**Files:**
- Modify: `src/modules/service-queue/service-queue.status.ts`
- Test: `src/modules/service-queue/service-queue.status.test.ts`

**Interfaces:**
- Consumes: Prisma types `ServiceQueueStatus`, `ServiceType` (Task 1).
- Produces: `PRIMARY_QUEUE_STATUS`, `COMPLETED_STATUS`, `isActiveQueueStatus(s): boolean`, `canComplete(s): boolean`, `canReopen(s): boolean`, `serviceTypeLabel(type: ServiceType, note: string | null): string`.

- [ ] **Step 1: Rewrite the test file**

Replace the entire contents of `src/modules/service-queue/service-queue.status.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  PRIMARY_QUEUE_STATUS,
  COMPLETED_STATUS,
  isActiveQueueStatus,
  canComplete,
  canReopen,
  serviceTypeLabel,
} from "./service-queue.status";

describe("service-queue status", () => {
  it("primary state is PENDING and done state is COMPLETED", () => {
    expect(PRIMARY_QUEUE_STATUS).toBe("PENDING");
    expect(COMPLETED_STATUS).toBe("COMPLETED");
  });

  it("only PENDING items are active on the queue", () => {
    expect(isActiveQueueStatus("PENDING")).toBe(true);
    expect(isActiveQueueStatus("COMPLETED")).toBe(false);
  });

  it("only PENDING can be completed; only COMPLETED can be reopened", () => {
    expect(canComplete("PENDING")).toBe(true);
    expect(canComplete("COMPLETED")).toBe(false);
    expect(canReopen("COMPLETED")).toBe(true);
    expect(canReopen("PENDING")).toBe(false);
  });
});

describe("serviceTypeLabel", () => {
  it("labels the fixed types", () => {
    expect(serviceTypeLabel("REIMAGE", null)).toBe("Reimage");
    expect(serviceTypeLabel("REPAIR", null)).toBe("Repair");
  });

  it("shows the custom note for OTHER, trimmed", () => {
    expect(serviceTypeLabel("OTHER", "  Screen cracked ")).toBe("Screen cracked");
  });

  it("falls back to 'Other' when OTHER has no note", () => {
    expect(serviceTypeLabel("OTHER", null)).toBe("Other");
    expect(serviceTypeLabel("OTHER", "   ")).toBe("Other");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/modules/service-queue/service-queue.status.test.ts`
Expected: FAIL (old exports `COMPLETED_STATUS`, `canComplete`, `serviceTypeLabel` do not exist yet).

- [ ] **Step 3: Rewrite `service-queue.status.ts`**

Replace the entire contents of `src/modules/service-queue/service-queue.status.ts`:

```typescript
import type { ServiceQueueStatus, ServiceType } from "@prisma/client";

// Pure status/label logic for the service queue. No Prisma runtime import (only
// the erased `import type`), so this is unit-testable without a database.

// In-queue state: the item needs active service/intervention.
export const PRIMARY_QUEUE_STATUS: ServiceQueueStatus = "PENDING";

// Service done. Retained, drops off the active queue, reversible.
export const COMPLETED_STATUS: ServiceQueueStatus = "COMPLETED";

// Whether an item in this status currently appears on the queue.
export function isActiveQueueStatus(status: ServiceQueueStatus): boolean {
  return status === PRIMARY_QUEUE_STATUS;
}

// Guard: only a PENDING item can be marked completed.
export function canComplete(status: ServiceQueueStatus): boolean {
  return status === PRIMARY_QUEUE_STATUS;
}

// Guard: only a COMPLETED item can be reopened back into the queue.
export function canReopen(status: ServiceQueueStatus): boolean {
  return status === COMPLETED_STATUS;
}

// Human label for the Service Type column. Fixed labels for REIMAGE/REPAIR; for
// OTHER, the custom note is "what needs to be done" — fall back to "Other" when
// the note is missing/blank.
export function serviceTypeLabel(type: ServiceType, note: string | null): string {
  if (type === "REIMAGE") return "Reimage";
  if (type === "REPAIR") return "Repair";
  const trimmed = (note ?? "").trim();
  return trimmed || "Other";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/modules/service-queue/service-queue.status.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/modules/service-queue/service-queue.status.ts src/modules/service-queue/service-queue.status.test.ts
git commit -m "feat(service-queue): COMPLETED lifecycle + serviceTypeLabel"
```

---

## Task 3: Errors + item-level service layer (delete obsolete modules)

**Files:**
- Modify: `src/modules/service-queue/service-queue.errors.ts`
- Modify: `src/modules/service-queue/service-queue.service.ts`
- Create: `src/modules/service-queue/service-queue.service.test.ts`
- Delete: `src/modules/service-queue/service-queue.enqueue.ts`, `service-queue.enqueue.test.ts`, `service-queue.group.ts`, `service-queue.group.test.ts`

**Interfaces:**
- Consumes: `PRIMARY_QUEUE_STATUS`, `COMPLETED_STATUS`, `canComplete`, `canReopen` (Task 2); `ServiceQueueError` (this task).
- Produces:
  - `type QueueRow` = `ServiceQueueItem & { item: { serialNumber; deviceName; homeUnit }; transfer: { receiptNumber } | null }`
  - `type ItemServiceRequest` = `ServiceQueueItem & { transfer: { receiptNumber } | null }`
  - `listActiveQueue(): Promise<QueueRow[]>`
  - `getServiceRequestForItem(itemId: string): Promise<ItemServiceRequest | null>`
  - `upsertServiceRequest(input: { itemId: string; serviceType: ServiceType; note?: string | null; transferId?: string | null }): Promise<ServiceQueueItem>`
  - `clearServiceRequest(itemId: string): Promise<void>`
  - `completeServiceItem(id: string): Promise<ServiceQueueItem>`
  - `reopenServiceItem(id: string): Promise<ServiceQueueItem>`

- [ ] **Step 1: Delete the obsolete modules**

```bash
git rm src/modules/service-queue/service-queue.enqueue.ts src/modules/service-queue/service-queue.enqueue.test.ts src/modules/service-queue/service-queue.group.ts src/modules/service-queue/service-queue.group.test.ts
```

- [ ] **Step 2: Extend the error codes**

Replace `src/modules/service-queue/service-queue.errors.ts`:

```typescript
export class ServiceQueueError extends Error {
  constructor(public code: "NOT_FOUND" | "INVALID_STATUS" | "NOTE_REQUIRED", message?: string) {
    super(message ?? code);
    this.name = "ServiceQueueError";
  }
}
```

- [ ] **Step 3: Write the service test (mocked prisma)**

Create `src/modules/service-queue/service-queue.service.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => {
  const tx = {
    serviceQueueItem: { findUnique: vi.fn(), update: vi.fn(), upsert: vi.fn() },
  };
  type Tx = typeof tx;
  return {
    default: {
      $transaction: vi.fn(async (fn: (tx: Tx) => unknown) => fn(tx)),
      serviceQueueItem: {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(),
        upsert: vi.fn(async () => ({ id: "sq1", status: "PENDING" })),
        delete: vi.fn(async () => ({})),
      },
    },
    __tx: tx,
  };
});

// @ts-expect-error test-only export
import { __tx } from "@/lib/prisma";
import prisma from "@/lib/prisma";
import {
  upsertServiceRequest,
  clearServiceRequest,
  completeServiceItem,
  reopenServiceItem,
  listActiveQueue,
} from "./service-queue.service";
import { ServiceQueueError } from "./service-queue.errors";

beforeEach(() => vi.clearAllMocks());

describe("upsertServiceRequest", () => {
  it("upserts a PENDING row keyed by itemId", async () => {
    await upsertServiceRequest({ itemId: "i1", serviceType: "REPAIR", transferId: "t1" });
    const arg = vi.mocked(prisma.serviceQueueItem.upsert).mock.calls[0][0];
    expect(arg.where).toEqual({ itemId: "i1" });
    expect(arg.create).toMatchObject({ itemId: "i1", serviceType: "REPAIR", transferId: "t1", status: "PENDING", serviceNote: null });
    expect(arg.update).toMatchObject({ serviceType: "REPAIR", transferId: "t1", status: "PENDING", serviceNote: null });
  });

  it("rejects OTHER without a note", async () => {
    await expect(upsertServiceRequest({ itemId: "i1", serviceType: "OTHER", note: "  " }))
      .rejects.toMatchObject({ code: "NOTE_REQUIRED" });
    expect(prisma.serviceQueueItem.upsert).not.toHaveBeenCalled();
  });

  it("keeps the trimmed note for OTHER", async () => {
    await upsertServiceRequest({ itemId: "i1", serviceType: "OTHER", note: " dead battery " });
    const arg = vi.mocked(prisma.serviceQueueItem.upsert).mock.calls[0][0];
    expect(arg.create.serviceNote).toBe("dead battery");
  });
});

describe("clearServiceRequest", () => {
  it("deletes the item's row", async () => {
    await clearServiceRequest("i1");
    expect(prisma.serviceQueueItem.delete).toHaveBeenCalledWith({ where: { itemId: "i1" } });
  });
});

describe("completeServiceItem", () => {
  it("PENDING -> COMPLETED", async () => {
    vi.mocked(__tx.serviceQueueItem.findUnique).mockResolvedValueOnce({ id: "sq1", status: "PENDING" });
    vi.mocked(__tx.serviceQueueItem.update).mockResolvedValueOnce({ id: "sq1", status: "COMPLETED" });
    const r = await completeServiceItem("sq1");
    expect(__tx.serviceQueueItem.update).toHaveBeenCalledWith({ where: { id: "sq1" }, data: { status: "COMPLETED" } });
    expect(r.status).toBe("COMPLETED");
  });

  it("throws INVALID_STATUS when already completed", async () => {
    vi.mocked(__tx.serviceQueueItem.findUnique).mockResolvedValueOnce({ id: "sq1", status: "COMPLETED" });
    await expect(completeServiceItem("sq1")).rejects.toBeInstanceOf(ServiceQueueError);
  });

  it("throws NOT_FOUND when missing", async () => {
    vi.mocked(__tx.serviceQueueItem.findUnique).mockResolvedValueOnce(null);
    await expect(completeServiceItem("nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("reopenServiceItem", () => {
  it("COMPLETED -> PENDING", async () => {
    vi.mocked(__tx.serviceQueueItem.findUnique).mockResolvedValueOnce({ id: "sq1", status: "COMPLETED" });
    vi.mocked(__tx.serviceQueueItem.update).mockResolvedValueOnce({ id: "sq1", status: "PENDING" });
    const r = await reopenServiceItem("sq1");
    expect(__tx.serviceQueueItem.update).toHaveBeenCalledWith({ where: { id: "sq1" }, data: { status: "PENDING" } });
    expect(r.status).toBe("PENDING");
  });
});

describe("listActiveQueue", () => {
  it("queries PENDING rows with item + transfer includes", async () => {
    await listActiveQueue();
    const arg = vi.mocked(prisma.serviceQueueItem.findMany).mock.calls[0][0];
    expect(arg.where).toEqual({ status: "PENDING" });
    expect(arg.include.item.select).toMatchObject({ serialNumber: true, deviceName: true, homeUnit: true });
    expect(arg.include.transfer.select).toMatchObject({ receiptNumber: true });
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run src/modules/service-queue/service-queue.service.test.ts`
Expected: FAIL (new functions not implemented / old file still receipt-level).

- [ ] **Step 5: Rewrite `service-queue.service.ts`**

Replace the entire contents of `src/modules/service-queue/service-queue.service.ts`:

```typescript
import type { Prisma, ServiceQueueItem, ServiceType } from "@prisma/client";
import prisma from "@/lib/prisma";
import { canComplete, canReopen } from "./service-queue.status";
import { ServiceQueueError } from "./service-queue.errors";

// Trimmed fields the queue list and item card render — never pull unrelated PII.
const queueItemSelect = { serialNumber: true, deviceName: true, homeUnit: true } satisfies Prisma.ItemSelect;
const queueTransferSelect = { receiptNumber: true } satisfies Prisma.TransferSelect;

export type QueueRow = ServiceQueueItem & {
  item: Prisma.ItemGetPayload<{ select: typeof queueItemSelect }>;
  transfer: Prisma.TransferGetPayload<{ select: typeof queueTransferSelect }> | null;
};

export type ItemServiceRequest = ServiceQueueItem & {
  transfer: Prisma.TransferGetPayload<{ select: typeof queueTransferSelect }> | null;
};

type UpsertInput = { itemId: string; serviceType: ServiceType; note?: string | null; transferId?: string | null };

// Normalize the note: trimmed value or null. OTHER requires a non-empty note.
function normalizeNote(serviceType: ServiceType, note: string | null | undefined): string | null {
  const trimmed = (note ?? "").trim();
  if (serviceType === "OTHER" && !trimmed) throw new ServiceQueueError("NOTE_REQUIRED");
  return trimmed || null;
}

// Create or update the item's single service request, (re)setting it to PENDING.
// `async` so the normalizeNote NOTE_REQUIRED throw surfaces as a rejected promise
// (a sync throw would escape callers' `.rejects`/try-await handling).
export async function upsertServiceRequest(input: UpsertInput): Promise<ServiceQueueItem> {
  const serviceNote = normalizeNote(input.serviceType, input.note);
  const transferId = input.transferId ?? null;
  return prisma.serviceQueueItem.upsert({
    where: { itemId: input.itemId },
    create: { itemId: input.itemId, serviceType: input.serviceType, serviceNote, transferId, status: "PENDING" },
    update: { serviceType: input.serviceType, serviceNote, transferId, status: "PENDING" },
  });
}

// Unflag: remove the item's service request entirely.
export async function clearServiceRequest(itemId: string): Promise<void> {
  await prisma.serviceQueueItem.delete({ where: { itemId } });
}

// PENDING -> COMPLETED. Guarded; never deletes.
export function completeServiceItem(id: string): Promise<ServiceQueueItem> {
  return transition(id, canComplete, "COMPLETED");
}

// COMPLETED -> PENDING (reopen from the item detail page). Guarded.
export function reopenServiceItem(id: string): Promise<ServiceQueueItem> {
  return transition(id, canReopen, "PENDING");
}

function transition(
  id: string,
  guard: (s: ServiceQueueItem["status"]) => boolean,
  next: ServiceQueueItem["status"],
): Promise<ServiceQueueItem> {
  return prisma.$transaction(async (tx) => {
    const current = await tx.serviceQueueItem.findUnique({ where: { id } });
    if (!current) throw new ServiceQueueError("NOT_FOUND");
    if (!guard(current.status)) throw new ServiceQueueError("INVALID_STATUS");
    return tx.serviceQueueItem.update({ where: { id }, data: { status: next } });
  });
}

// The active queue: PENDING rows with the fields the item table renders.
export function listActiveQueue(): Promise<QueueRow[]> {
  return prisma.serviceQueueItem.findMany({
    where: { status: "PENDING" },
    orderBy: { createdAt: "desc" },
    include: { item: { select: queueItemSelect }, transfer: { select: queueTransferSelect } },
  }) as Promise<QueueRow[]>;
}

// The item's current service request (any status), for the item detail card.
export function getServiceRequestForItem(itemId: string): Promise<ItemServiceRequest | null> {
  return prisma.serviceQueueItem.findUnique({
    where: { itemId },
    include: { transfer: { select: queueTransferSelect } },
  }) as Promise<ItemServiceRequest | null>;
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run src/modules/service-queue/service-queue.service.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/modules/service-queue
git commit -m "feat(service-queue): item-level service layer; drop receipt-level enqueue/group"
```

---

## Task 4: Per-item service form parsing (pure module)

**Files:**
- Create: `src/modules/service-queue/service-form.ts`
- Test: `src/modules/service-queue/service-form.test.ts`

**Interfaces:**
- Consumes: Prisma type `ServiceType` (Task 1).
- Produces:
  - `type ServiceSelection = { serviceType: ServiceType; note: string | null }`
  - `parseServiceMap(fd: FormData): Map<string, ServiceSelection>` — reads `service[<itemId>][needs|type|note]`; includes only entries whose `needs` is on and whose `type` is a valid `ServiceType`.
  - `SERVICE_TYPE_OPTIONS: { value: ServiceType; label: string }[]` (for the builder + item controls).

- [ ] **Step 1: Write the test**

Create `src/modules/service-queue/service-form.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseServiceMap } from "./service-form";

function fd(entries: [string, string][]): FormData {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
}

describe("parseServiceMap", () => {
  it("includes only checked items with a valid type", () => {
    const f = fd([
      ["service[i1][needs]", "on"],
      ["service[i1][type]", "REIMAGE"],
      ["service[i2][type]", "REPAIR"], // not checked -> excluded
      ["service[i3][needs]", "on"],
      ["service[i3][type]", "BOGUS"], // invalid -> excluded
    ]);
    const m = parseServiceMap(f);
    expect([...m.keys()]).toEqual(["i1"]);
    expect(m.get("i1")).toEqual({ serviceType: "REIMAGE", note: null });
  });

  it("captures the trimmed note for OTHER and null otherwise", () => {
    const f = fd([
      ["service[i1][needs]", "on"],
      ["service[i1][type]", "OTHER"],
      ["service[i1][note]", "  cracked screen "],
      ["service[i2][needs]", "on"],
      ["service[i2][type]", "REPAIR"],
      ["service[i2][note]", "ignored for non-OTHER"],
    ]);
    const m = parseServiceMap(f);
    expect(m.get("i1")).toEqual({ serviceType: "OTHER", note: "cracked screen" });
    expect(m.get("i2")).toEqual({ serviceType: "REPAIR", note: null });
  });

  it("returns an empty map when nothing is flagged", () => {
    expect(parseServiceMap(fd([])).size).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/modules/service-queue/service-form.test.ts`
Expected: FAIL ("Cannot find module './service-form'").

- [ ] **Step 3: Implement `service-form.ts`**

Create `src/modules/service-queue/service-form.ts`:

```typescript
import type { ServiceType } from "@prisma/client";

export type ServiceSelection = { serviceType: ServiceType; note: string | null };

export const SERVICE_TYPE_OPTIONS: { value: ServiceType; label: string }[] = [
  { value: "REIMAGE", label: "Reimage" },
  { value: "REPAIR", label: "Repair" },
  { value: "OTHER", label: "Other" },
];

const VALID_TYPES = new Set<string>(SERVICE_TYPE_OPTIONS.map((o) => o.value));
// Matches service[<itemId>][needs|type|note]. itemId is a cuid (no brackets).
const FIELD_RE = /^service\[([^\]]+)\]\[(needs|type|note)\]$/;

// Pure extraction of the per-item "Needs service?" selections from a receipt
// form. Only rows whose `needs` is on AND whose `type` is a known ServiceType
// are returned. For OTHER the trimmed note is carried; otherwise note is null.
// Note validity (OTHER requires a note) is enforced later by upsertServiceRequest.
export function parseServiceMap(fd: FormData): Map<string, ServiceSelection> {
  const rows = new Map<string, { needs: boolean; type?: string; note?: string }>();
  for (const [key, value] of fd.entries()) {
    const m = FIELD_RE.exec(key);
    if (!m) continue;
    const [, itemId, field] = m;
    const row = rows.get(itemId) ?? { needs: false };
    if (field === "needs") row.needs = value === "on" || value === "true";
    else if (field === "type") row.type = String(value);
    else row.note = String(value);
    rows.set(itemId, row);
  }

  const result = new Map<string, ServiceSelection>();
  for (const [itemId, row] of rows) {
    if (!row.needs || !row.type || !VALID_TYPES.has(row.type)) continue;
    const serviceType = row.type as ServiceType;
    const note = serviceType === "OTHER" ? (row.note ?? "").trim() || null : null;
    result.set(itemId, { serviceType, note });
  }
  return result;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/modules/service-queue/service-form.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/service-queue/service-form.ts src/modules/service-queue/service-form.test.ts
git commit -m "feat(service-queue): pure per-item service form parser"
```

---

## Task 5: Receipt intake — per-item "Needs service?" capture

**Files:**
- Modify: `src/app/receipts/new/page.tsx:18,40-44`
- Modify: `src/app/receipts/new/ReceiptBuilderForm.tsx` (`BuilderLine` type + Items table)
- Modify: `src/app/actions/receipts.ts:11,26-30`

**Interfaces:**
- Consumes: `parseServiceMap`, `SERVICE_TYPE_OPTIONS` (Task 4); `upsertServiceRequest` (Task 3); `ReceiptLine.itemIds` (`src/modules/transfers/receipt-lines.ts`).
- Produces: builder posts `service[<itemId>][needs|type|note]`; `createReceiptAction` creates PENDING service rows tied to the new transfer for each flagged item.

- [ ] **Step 1: Thread per-serial itemIds into the builder (`page.tsx`)**

In `src/app/receipts/new/page.tsx`, replace the `<ReceiptBuilderForm .../>` `lines` prop (line ~42) so each line carries `{ serialNumber, itemId }` pairs:

```tsx
          <ReceiptBuilderForm
            itemIds={loaded.map((i) => i.id)}
            lines={lines.map((l) => ({
              make: l.make,
              model: l.model,
              defaultQty: l.defaultQty,
              items: l.serials.map((serialNumber, k) => ({ serialNumber, itemId: l.itemIds[k] })),
            }))}
            senderPrefill={senderPrefill}
          />
```

- [ ] **Step 2: Update `BuilderLine` and render per-serial service controls (`ReceiptBuilderForm.tsx`)**

In `src/app/receipts/new/ReceiptBuilderForm.tsx`:

(a) Update the import block and `BuilderLine` type:

```tsx
"use client";
import { Fragment, useActionState, useState } from "react";
import { createReceiptAction } from "@/app/actions/receipts";
import { SignaturePad } from "@/components/SignaturePad";
import { PhoneInput } from "@/components/PhoneInput";
import { SERVICE_TYPE_OPTIONS } from "@/modules/service-queue/service-form";

type Prefill = { isDcsim?: boolean; name?: string; rank?: string; unit?: string; contact?: string; email?: string };
export type BuilderItem = { serialNumber: string; itemId: string };
export type BuilderLine = { make: string; model: string; items: BuilderItem[]; defaultQty: number };
```

(b) Add a `ServiceControls` sub-component (place above `ReceiptBuilderForm`):

```tsx
// Per-serial "Needs service?" capture. Checking it reveals the service type;
// choosing "Other" reveals a custom-message input. Field names are namespaced by
// itemId so parseServiceMap can reconstruct the per-item selection server-side.
function ServiceControls({ itemId }: { itemId: string }) {
  const [needs, setNeeds] = useState(false);
  const [type, setType] = useState("REIMAGE");
  return (
    <div className="stack-sm">
      <label className="row" style={{ gap: 6 }}>
        <input
          type="checkbox"
          name={`service[${itemId}][needs]`}
          checked={needs}
          onChange={(e) => setNeeds(e.target.checked)}
        />
        Needs service?
      </label>
      {needs && (
        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          <select
            className="select"
            style={{ width: "auto", minWidth: 130 }}
            name={`service[${itemId}][type]`}
            value={type}
            onChange={(e) => setType(e.target.value)}
            aria-label="Service type"
          >
            {SERVICE_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          {type === "OTHER" && (
            <input
              className="input"
              style={{ minWidth: 200 }}
              name={`service[${itemId}][note]`}
              placeholder="Describe the service needed"
              required
            />
          )}
        </div>
      )}
    </div>
  );
}
```

(c) Replace the Items table `<thead>`/`<tbody>` so each serial is its own row with the controls. Replace the existing `<table className="table">…</table>` inside the Items fieldset with:

```tsx
          <table className="table">
            <thead><tr><th>#</th><th>Item</th><th>Serial</th><th>Service</th><th>Auth</th><th>Issued</th></tr></thead>
            <tbody>
              {lines.map((ln, i) => (
                <Fragment key={ln.items[0].itemId}>
                  <tr>
                    <td>{i + 1}</td>
                    <td>{ln.make} {ln.model}
                      <input type="hidden" name={`line[${i}][make]`} value={ln.make} />
                      <input type="hidden" name={`line[${i}][model]`} value={ln.model} />
                    </td>
                    <td className="mono">{ln.items[0].serialNumber}</td>
                    <td><ServiceControls itemId={ln.items[0].itemId} /></td>
                    <td rowSpan={ln.items.length}><input className="input" style={{ width: 72 }} type="number" min={1} name={`line[${i}][qtyAuth]`} defaultValue={ln.defaultQty} required /></td>
                    <td rowSpan={ln.items.length}><input className="input" style={{ width: 72 }} type="number" min={1} name={`line[${i}][qtyIssued]`} defaultValue={ln.defaultQty} required /></td>
                  </tr>
                  {ln.items.slice(1).map((it) => (
                    <tr key={it.itemId}>
                      <td></td>
                      <td></td>
                      <td className="mono">{it.serialNumber}</td>
                      <td><ServiceControls itemId={it.itemId} /></td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
```

- [ ] **Step 3: Create service rows in the action (`receipts.ts`)**

In `src/app/actions/receipts.ts`:

(a) Replace the `enqueueTransfer` import (line 11) with:

```typescript
import { upsertServiceRequest } from "@/modules/service-queue/service-queue.service";
import { parseServiceMap } from "@/modules/service-queue/service-form";
```

(b) Replace the enqueue block (lines ~25-30) with per-item service creation:

```typescript
    // [Service Queue] For each item flagged "Needs service?" on the form, create
    // an item-level service request tied to this receipt. Best-effort: a queue
    // hiccup must not fail the already-created receipt.
    const serviceMap = parseServiceMap(formData);
    for (const [itemId, sel] of serviceMap) {
      try {
        await upsertServiceRequest({ itemId, serviceType: sel.serviceType, note: sel.note, transferId: t.id });
      } catch (err) {
        console.error(`[createReceiptAction] service enqueue failed for item ${itemId}:`, err);
      }
    }
```

- [ ] **Step 4: Verify affected unit tests still pass**

Run: `npx vitest run src/modules/service-queue src/app/actions`
Expected: PASS (no receipts.ts unit test exists; the service-queue + parse tests still pass). This confirms no regressions in the touched modules.

- [ ] **Step 5: Commit**

```bash
git add src/app/receipts/new/page.tsx src/app/receipts/new/ReceiptBuilderForm.tsx src/app/actions/receipts.ts
git commit -m "feat(receipts): per-item Needs service? capture on the receipt builder"
```

---

## Task 6: Item detail Service card + admin actions

**Files:**
- Modify: `src/modules/transfers/transfers.service.ts` (add `getCurrentOpenTransferId`)
- Modify: `src/app/admin/actions/queue.ts` (replace with item-level actions)
- Create: `src/app/i/[itemId]/ServiceControls.tsx`
- Modify: `src/app/i/[itemId]/page.tsx` (add Service card)

**Interfaces:**
- Consumes: `upsertServiceRequest`, `clearServiceRequest`, `completeServiceItem`, `reopenServiceItem`, `getServiceRequestForItem` (Task 3); `serviceTypeLabel` (Task 2); `SERVICE_TYPE_OPTIONS` (Task 4); `ServiceQueueError` (Task 3).
- Produces:
  - `getCurrentOpenTransferId(itemId: string): Promise<string | null>`
  - Server actions in `queue.ts`: `setServiceAction(formData)`, `clearServiceAction(formData)`, `completeServiceAction(formData)`, `reopenServiceAction(formData)`.

- [ ] **Step 1: Add `getCurrentOpenTransferId` to transfers.service.ts**

Append to `src/modules/transfers/transfers.service.ts`:

```typescript
// The item's current holder receipt id: the most-recent transfer, but only when
// it is still OPEN (a CLOSED receipt means it was returned — no current holder).
// Used to tie a service request flagged from the item page to the live receipt.
export async function getCurrentOpenTransferId(itemId: string): Promise<string | null> {
  const last = await prisma.transfer.findFirst({
    where: { lines: { some: { items: { some: { itemId } } } } },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true },
  });
  return last && last.status === "OPEN" ? last.id : null;
}
```

- [ ] **Step 2: Replace `queue.ts` with item-level actions**

Replace the entire contents of `src/app/admin/actions/queue.ts`:

```typescript
"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/authz";
import {
  upsertServiceRequest,
  clearServiceRequest,
  completeServiceItem,
  reopenServiceItem,
} from "@/modules/service-queue/service-queue.service";
import { getCurrentOpenTransferId } from "@/modules/transfers/transfers.service";
import { ServiceQueueError } from "@/modules/service-queue/service-queue.errors";

const idSchema = z.object({ id: z.string().min(1) });
const setSchema = z.object({
  itemId: z.string().min(1),
  serviceType: z.enum(["REIMAGE", "REPAIR", "OTHER"]),
  note: z.string().optional(),
});

function revalidateItem(itemId: string) {
  revalidatePath("/admin/queue");
  revalidatePath(`/i/${itemId}`);
}

// Flag/update an item's service request from the item detail page. Ties it to the
// item's current open receipt (if any). Returns a generic error string to the UI.
export async function setServiceAction(_prev: unknown, formData: FormData): Promise<{ error?: string; ok?: true }> {
  await requireAdmin();
  const parsed = setSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  try {
    const transferId = await getCurrentOpenTransferId(parsed.data.itemId);
    await upsertServiceRequest({ ...parsed.data, transferId });
  } catch (e) {
    if (e instanceof ServiceQueueError && e.code === "NOTE_REQUIRED") {
      return { error: "Describe the service needed for 'Other'." };
    }
    console.error("[setServiceAction] unexpected error:", e);
    return { error: "Something went wrong. Please try again." };
  }
  revalidateItem(parsed.data.itemId);
  return { ok: true };
}

// Unflag an item (remove its service request).
export async function clearServiceAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const itemId = String(formData.get("itemId") ?? "");
  if (!itemId) return;
  try {
    await clearServiceRequest(itemId);
  } catch (e) {
    console.error("[clearServiceAction] unexpected error:", e);
  }
  revalidateItem(itemId);
}

// Mark a queue item completed (from the queue or the item page).
export async function completeServiceAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const parsed = idSchema.safeParse({ id: String(formData.get("id") ?? "") });
  if (!parsed.success) return;
  const itemId = String(formData.get("itemId") ?? "");
  try {
    await completeServiceItem(parsed.data.id);
  } catch (e) {
    if (!(e instanceof ServiceQueueError)) console.error("[completeServiceAction] unexpected error:", e);
  }
  revalidatePath("/admin/queue");
  if (itemId) revalidatePath(`/i/${itemId}`);
}

// Reopen a completed item back into the queue (from the item page).
export async function reopenServiceAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const parsed = idSchema.safeParse({ id: String(formData.get("id") ?? "") });
  if (!parsed.success) return;
  const itemId = String(formData.get("itemId") ?? "");
  try {
    await reopenServiceItem(parsed.data.id);
  } catch (e) {
    if (!(e instanceof ServiceQueueError)) console.error("[reopenServiceAction] unexpected error:", e);
  }
  revalidatePath("/admin/queue");
  if (itemId) revalidatePath(`/i/${itemId}`);
}
```

- [ ] **Step 3: Create the admin `ServiceControls` client component**

Create `src/app/i/[itemId]/ServiceControls.tsx`:

```tsx
"use client";
import { useActionState, useState } from "react";
import { setServiceAction, clearServiceAction, completeServiceAction, reopenServiceAction } from "@/app/admin/actions/queue";
import { SERVICE_TYPE_OPTIONS } from "@/modules/service-queue/service-form";

type Props = {
  itemId: string;
  request: { id: string; serviceType: "REIMAGE" | "REPAIR" | "OTHER"; serviceNote: string | null; status: "PENDING" | "COMPLETED" } | null;
};

// Admin-only controls on the item detail Service card: flag/update the request,
// clear it, and mark completed / reopen. Kept separate from the read-only card so
// non-admins never load it.
export function ServiceControls({ itemId, request }: Props) {
  const [state, action, pending] = useActionState(setServiceAction, undefined);
  const [type, setType] = useState<string>(request?.serviceType ?? "REIMAGE");

  return (
    <div className="stack-sm">
      <form action={action} className="stack-sm">
        <input type="hidden" name="itemId" value={itemId} />
        <div className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label className="stack" style={{ gap: 4 }}>
            <span className="subtle" style={{ fontSize: 12 }}>Service type</span>
            <select className="select" style={{ width: "auto", minWidth: 130 }} name="serviceType" value={type} onChange={(e) => setType(e.target.value)}>
              {SERVICE_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
          {type === "OTHER" && (
            <input className="input" style={{ minWidth: 200 }} name="note" placeholder="Describe the service needed" defaultValue={request?.serviceNote ?? ""} required />
          )}
          <button className="btn btn-primary" disabled={pending} type="submit">
            {pending ? "Saving…" : request ? "Update service" : "Flag for service"}
          </button>
        </div>
        {state?.error && <p role="alert" className="alert-error">{state.error}</p>}
        {state?.ok && <p className="alert-success">Saved.</p>}
      </form>

      {request && (
        <div className="row" style={{ gap: 6 }}>
          {request.status === "PENDING" ? (
            <form action={completeServiceAction}>
              <input type="hidden" name="id" value={request.id} />
              <input type="hidden" name="itemId" value={itemId} />
              <button type="submit" className="btn btn-secondary btn-sm">Mark Completed</button>
            </form>
          ) : (
            <form action={reopenServiceAction}>
              <input type="hidden" name="id" value={request.id} />
              <input type="hidden" name="itemId" value={itemId} />
              <button type="submit" className="btn btn-secondary btn-sm">Reopen</button>
            </form>
          )}
          <form action={clearServiceAction}>
            <input type="hidden" name="itemId" value={itemId} />
            <button type="submit" className="btn btn-ghost btn-sm">Remove service flag</button>
          </form>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Add the Service card to the item page**

In `src/app/i/[itemId]/page.tsx`:

(a) Add imports near the top:

```tsx
import { getServiceRequestForItem } from "@/modules/service-queue/service-queue.service";
import { serviceTypeLabel } from "@/modules/service-queue/service-queue.status";
import { ServiceControls } from "./ServiceControls";
```

(b) Add `getServiceRequestForItem(itemId)` to the `Promise.all` (line ~15-20):

```tsx
  const [item, user, receipts, qr, service] = await Promise.all([
    getItemWithCreator(itemId),
    getCurrentUser(),
    listReceiptsForItem(itemId),
    itemQrDataUrl(itemId).catch((e) => { console.error("[item-page] QR generation failed:", e); return ""; }),
    getServiceRequestForItem(itemId),
  ]);
```

(c) Insert the Service card immediately after the closing `)}` of the `loggedIn && (...)` details card (after line ~64), before the QR card:

```tsx
        {loggedIn && (
          <div className="card">
            <div className="card__title">Service</div>
            {service && service.status === "PENDING" ? (
              <dl className="dl">
                <dt>Status</dt>
                <dd>Needs service</dd>
                <dt>Service type</dt>
                <dd>{serviceTypeLabel(service.serviceType, service.serviceNote)}</dd>
                <dt>Hand receipt</dt>
                <dd>
                  {service.transfer
                    ? <Link href={`/receipts/${service.transfer.receiptNumber}`}><strong>{service.transfer.receiptNumber}</strong></Link>
                    : "—"}
                </dd>
              </dl>
            ) : service && service.status === "COMPLETED" ? (
              <p className="subtle">Service completed. {serviceTypeLabel(service.serviceType, service.serviceNote)}.</p>
            ) : (
              <p className="subtle">This item is not flagged for service.</p>
            )}
            {isAdmin && (
              <ServiceControls
                itemId={item.id}
                request={service ? { id: service.id, serviceType: service.serviceType, serviceNote: service.serviceNote, status: service.status } : null}
              />
            )}
          </div>
        )}
```

- [ ] **Step 5: Verify touched module tests pass**

Run: `npx vitest run src/modules/service-queue src/modules/transfers`
Expected: PASS (service-queue + transfers unit tests unaffected).

- [ ] **Step 6: Commit**

```bash
git add src/modules/transfers/transfers.service.ts src/app/admin/actions/queue.ts src/app/i/[itemId]/ServiceControls.tsx src/app/i/[itemId]/page.tsx
git commit -m "feat(items): service card + admin flag/complete/reopen on item detail"
```

---

## Task 7: Extract the persisted-pref localStorage hook

**Files:**
- Create: `src/components/persisted-pref.ts`
- Modify: `src/components/ItemSelectTable.tsx:1-63` (remove inline store; import from the new module)

**Interfaces:**
- Produces:
  - `makeStore<T>(key: string, parse: (raw: string | null) => T): { get(): T; set(v: T): void; subscribe(cb: () => void): () => void }`
  - `usePersistedPref<T>(store, serverDefault: T): [T, (value: T) => void]`

- [ ] **Step 1: Create the shared module (verbatim move from ItemSelectTable)**

Create `src/components/persisted-pref.ts`:

```typescript
import { useSyncExternalStore } from "react";

/** A tiny localStorage-backed store, created at module scope so its mutable
 *  cache lives outside React's render cycle. Read via useSyncExternalStore so
 *  the server snapshot (default) is used during SSR/hydration and the persisted
 *  value takes over on the client — no hydration mismatch, no setState-in-effect.
 *  Also syncs across tabs via the `storage` event. */
export function makeStore<T>(key: string, parse: (raw: string | null) => T) {
  const listeners = new Set<() => void>();
  let cacheRaw: string | null | undefined;
  let cacheVal: T;
  return {
    get(): T {
      let raw: string | null = null;
      try { raw = window.localStorage.getItem(key); } catch { /* unavailable */ }
      if (cacheRaw !== raw) { cacheRaw = raw; cacheVal = parse(raw); }
      return cacheVal;
    },
    set(value: T) {
      try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* unavailable */ }
      cacheRaw = undefined;
      listeners.forEach((l) => l());
    },
    subscribe(cb: () => void) {
      listeners.add(cb);
      const onStorage = (e: StorageEvent) => { if (e.key === key) { cacheRaw = undefined; cb(); } };
      window.addEventListener("storage", onStorage);
      return () => { listeners.delete(cb); window.removeEventListener("storage", onStorage); };
    },
  };
}

export function usePersistedPref<T>(
  store: { get: () => T; set: (v: T) => void; subscribe: (cb: () => void) => () => void },
  serverDefault: T,
): [T, (value: T) => void] {
  const value = useSyncExternalStore(store.subscribe, store.get, () => serverDefault);
  return [value, store.set];
}
```

- [ ] **Step 2: Update ItemSelectTable to import the hook**

In `src/components/ItemSelectTable.tsx`:

(a) Change the React import on line 2 to drop `useSyncExternalStore`:

```tsx
import { useMemo, useState } from "react";
```

(b) Add this import after the other `@/components` imports (after line 7):

```tsx
import { makeStore, usePersistedPref } from "@/components/persisted-pref";
```

(c) Delete the inline `makeStore` function (lines ~27-55) and the inline `usePersistedPref` function (lines ~60-63). Keep the `sortStore`/`hiddenStore` `const` declarations (they now call the imported `makeStore`).

- [ ] **Step 3: Verify the items view still builds and existing tests pass**

Run: `npx vitest run src/components`
Expected: PASS (`items-view.test.ts` unaffected). The extraction is behavior-preserving.

- [ ] **Step 4: Commit**

```bash
git add src/components/persisted-pref.ts src/components/ItemSelectTable.tsx
git commit -m "refactor(components): extract persisted-pref localStorage hook for reuse"
```

---

## Task 8: Service-queue view helper (columns / sort / filter)

**Files:**
- Create: `src/components/service-queue-view.ts`
- Test: `src/components/service-queue-view.test.ts`

**Interfaces:**
- Produces:
  - `type QueueSortField = "serialNumber" | "deviceName" | "homeUnit" | "serviceType"`
  - `type QueueRowVM = { id: string; itemId: string; serialNumber: string; deviceName: string | null; homeUnit: string | null; serviceType: string; serviceTypeRaw: "REIMAGE" | "REPAIR" | "OTHER" }`
  - `type QueueSortPref = { field: QueueSortField | null; dir: "asc" | "desc" }`
  - `QUEUE_COLUMNS: { key: QueueSortField; label: string }[]`
  - `sortQueueRows(rows, field, dir): QueueRowVM[]`
  - `filterQueueRows(rows, { search, type }): QueueRowVM[]`
  - `parseQueueSort(raw): QueueSortPref`, `parseQueueHidden(raw): QueueSortField[]`

- [ ] **Step 1: Write the test**

Create `src/components/service-queue-view.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  sortQueueRows,
  filterQueueRows,
  parseQueueSort,
  parseQueueHidden,
  QUEUE_COLUMNS,
  type QueueRowVM,
} from "./service-queue-view";

const rows: QueueRowVM[] = [
  { id: "1", itemId: "i1", serialNumber: "B2", deviceName: "Laptop-9", homeUnit: "A Co", serviceType: "Reimage", serviceTypeRaw: "REIMAGE" },
  { id: "2", itemId: "i2", serialNumber: "A1", deviceName: null, homeUnit: "B Co", serviceType: "cracked screen", serviceTypeRaw: "OTHER" },
  { id: "3", itemId: "i3", serialNumber: "C3", deviceName: "Tablet-1", homeUnit: null, serviceType: "Repair", serviceTypeRaw: "REPAIR" },
];

describe("sortQueueRows", () => {
  it("sorts by serial ascending and descending; unmutated input", () => {
    expect(sortQueueRows(rows, "serialNumber", "asc").map((r) => r.serialNumber)).toEqual(["A1", "B2", "C3"]);
    expect(sortQueueRows(rows, "serialNumber", "desc").map((r) => r.serialNumber)).toEqual(["C3", "B2", "A1"]);
    expect(rows[0].serialNumber).toBe("B2");
  });

  it("sorts blanks last regardless of direction", () => {
    expect(sortQueueRows(rows, "deviceName", "asc").map((r) => r.deviceName)).toEqual(["Laptop-9", "Tablet-1", null]);
    expect(sortQueueRows(rows, "deviceName", "desc").map((r) => r.deviceName)).toEqual(["Tablet-1", "Laptop-9", null]);
  });

  it("returns a copy in original order when field is null", () => {
    expect(sortQueueRows(rows, null, "asc").map((r) => r.id)).toEqual(["1", "2", "3"]);
  });
});

describe("filterQueueRows", () => {
  it("search matches SN, device name, or unit (case-insensitive)", () => {
    expect(filterQueueRows(rows, { search: "laptop", type: "ALL" }).map((r) => r.id)).toEqual(["1"]);
    expect(filterQueueRows(rows, { search: "b co", type: "ALL" }).map((r) => r.id)).toEqual(["2"]);
    expect(filterQueueRows(rows, { search: "a1", type: "ALL" }).map((r) => r.id)).toEqual(["2"]);
  });

  it("filters by service type using the raw enum", () => {
    expect(filterQueueRows(rows, { search: "", type: "OTHER" }).map((r) => r.id)).toEqual(["2"]);
    expect(filterQueueRows(rows, { search: "", type: "REIMAGE" }).map((r) => r.id)).toEqual(["1"]);
  });

  it("combines search and type", () => {
    expect(filterQueueRows(rows, { search: "c3", type: "REIMAGE" })).toEqual([]);
  });
});

describe("parse helpers", () => {
  it("parseQueueSort validates field + dir", () => {
    expect(parseQueueSort(JSON.stringify({ field: "homeUnit", dir: "desc" }))).toEqual({ field: "homeUnit", dir: "desc" });
    expect(parseQueueSort(JSON.stringify({ field: "bogus", dir: "asc" }))).toEqual({ field: null, dir: "asc" });
    expect(parseQueueSort(null)).toEqual({ field: null, dir: "asc" });
  });

  it("parseQueueHidden keeps known keys and never hides every column", () => {
    expect(parseQueueHidden(JSON.stringify(["deviceName", "homeUnit"]))).toEqual(["deviceName", "homeUnit"]);
    expect(parseQueueHidden(JSON.stringify(QUEUE_COLUMNS.map((c) => c.key)))).toEqual([]);
    expect(parseQueueHidden(JSON.stringify(["nope"]))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/service-queue-view.test.ts`
Expected: FAIL ("Cannot find module './service-queue-view'").

- [ ] **Step 3: Implement `service-queue-view.ts`**

Create `src/components/service-queue-view.ts`:

```typescript
export type QueueSortField = "serialNumber" | "deviceName" | "homeUnit" | "serviceType";
export type SortDir = "asc" | "desc";

export type QueueRowVM = {
  id: string;
  itemId: string;
  serialNumber: string;
  deviceName: string | null;
  homeUnit: string | null;
  serviceType: string; // display label
  serviceTypeRaw: "REIMAGE" | "REPAIR" | "OTHER"; // for filtering
};

export type QueueSortPref = { field: QueueSortField | null; dir: SortDir };
export type QueueTypeFilter = "ALL" | "REIMAGE" | "REPAIR" | "OTHER";

export const QUEUE_COLUMNS: { key: QueueSortField; label: string }[] = [
  { key: "serialNumber", label: "SN" },
  { key: "deviceName", label: "Device Name" },
  { key: "homeUnit", label: "Unit" },
  { key: "serviceType", label: "Service Type" },
];

const SORT_FIELDS = new Set<string>(QUEUE_COLUMNS.map((c) => c.key));
const DEFAULT_SORT: QueueSortPref = { field: null, dir: "asc" };

/** Case-insensitive sort by a field. Null/blank values sort last in both
 *  directions. Returns a new array; the input is not mutated. */
export function sortQueueRows(rows: QueueRowVM[], field: QueueSortField | null, dir: SortDir): QueueRowVM[] {
  const copy = rows.slice();
  if (!field) return copy;
  copy.sort((a, b) => {
    const av = a[field];
    const bv = b[field];
    const aBlank = av == null || av === "";
    const bBlank = bv == null || bv === "";
    if (aBlank && bBlank) return 0;
    if (aBlank) return 1;
    if (bBlank) return -1;
    const base = String(av).localeCompare(String(bv), undefined, { sensitivity: "base" });
    return dir === "asc" ? base : -base;
  });
  return copy;
}

/** Client-side search (SN / Device Name / Unit) + service-type filter. */
export function filterQueueRows(rows: QueueRowVM[], opts: { search: string; type: QueueTypeFilter }): QueueRowVM[] {
  const q = opts.search.trim().toLowerCase();
  return rows.filter((r) => {
    if (opts.type !== "ALL" && r.serviceTypeRaw !== opts.type) return false;
    if (!q) return true;
    const hay = [r.serialNumber, r.deviceName ?? "", r.homeUnit ?? ""].join(" ").toLowerCase();
    return hay.includes(q);
  });
}

export function parseQueueSort(raw: string | null): QueueSortPref {
  if (!raw) return DEFAULT_SORT;
  try {
    const v = JSON.parse(raw) as { field?: unknown; dir?: unknown };
    const field = typeof v.field === "string" && SORT_FIELDS.has(v.field) ? (v.field as QueueSortField) : null;
    const dir = v.dir === "desc" ? "desc" : v.dir === "asc" ? "asc" : null;
    if (!dir) return DEFAULT_SORT;
    return { field, dir };
  } catch {
    return DEFAULT_SORT;
  }
}

export function parseQueueHidden(raw: string | null): QueueSortField[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    const cols = v.filter((k): k is QueueSortField => typeof k === "string" && SORT_FIELDS.has(k));
    // Never hide every data column — that would leave a column-less table.
    if (cols.length >= QUEUE_COLUMNS.length) return [];
    return cols;
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/components/service-queue-view.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/service-queue-view.ts src/components/service-queue-view.test.ts
git commit -m "feat(service-queue): view helper (columns/sort/filter/prefs)"
```

---

## Task 9: Service queue table + item-level `/admin/queue` page

**Files:**
- Create: `src/components/ServiceQueueTable.tsx`
- Modify: `src/app/admin/queue/page.tsx` (full replacement)

**Interfaces:**
- Consumes: `QUEUE_COLUMNS`, `sortQueueRows`, `filterQueueRows`, `parseQueueSort`, `parseQueueHidden`, `QueueRowVM`, `QueueSortField`, `QueueSortPref`, `QueueTypeFilter` (Task 8); `makeStore`, `usePersistedPref` (Task 7); `completeServiceAction` (Task 6); `listActiveQueue` (Task 3); `serviceTypeLabel` (Task 2).

- [ ] **Step 1: Create the client table**

Create `src/components/ServiceQueueTable.tsx`:

```tsx
"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { completeServiceAction } from "@/app/admin/actions/queue";
import { makeStore, usePersistedPref } from "@/components/persisted-pref";
import {
  QUEUE_COLUMNS,
  sortQueueRows,
  filterQueueRows,
  parseQueueSort,
  parseQueueHidden,
  type QueueRowVM,
  type QueueSortField,
  type QueueSortPref,
  type QueueTypeFilter,
} from "@/components/service-queue-view";

const SORT_KEY = "queue:sort";
const HIDDEN_KEY = "queue:hiddenCols";
const DEFAULT_SORT: QueueSortPref = { field: null, dir: "asc" };
const DEFAULT_HIDDEN: QueueSortField[] = [];

const sortStore = makeStore(SORT_KEY, parseQueueSort);
const hiddenStore = makeStore(HIDDEN_KEY, parseQueueHidden);

const TYPE_FILTERS: { value: QueueTypeFilter; label: string }[] = [
  { value: "ALL", label: "All types" },
  { value: "REIMAGE", label: "Reimage" },
  { value: "REPAIR", label: "Repair" },
  { value: "OTHER", label: "Other" },
];

export function ServiceQueueTable({ rows }: { rows: QueueRowVM[] }) {
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<QueueTypeFilter>("ALL");
  const [sort, setSort] = usePersistedPref(sortStore, DEFAULT_SORT);
  const [hidden, setHidden] = usePersistedPref(hiddenStore, DEFAULT_HIDDEN);

  const isHidden = (key: QueueSortField) => hidden.includes(key);
  const visibleCols = QUEUE_COLUMNS.filter((c) => !isHidden(c.key));

  const shown = useMemo(() => {
    const filtered = filterQueueRows(rows, { search, type: typeFilter });
    return sortQueueRows(filtered, sort.field, sort.dir);
  }, [rows, search, typeFilter, sort]);

  const toggleCol = (key: QueueSortField) => {
    const next = new Set(hidden);
    if (next.has(key)) { next.delete(key); setHidden([...next]); return; }
    if (QUEUE_COLUMNS.length - next.size <= 1) return; // keep one visible
    next.add(key);
    setHidden([...next]);
  };

  return (
    <>
      <div className="row" style={{ gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
        <input
          className="input"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search SN, device name, or unit"
          style={{ maxWidth: 320 }}
          aria-label="Search the service queue"
        />
        <label className="stack" style={{ gap: 4 }}>
          <span className="subtle" style={{ fontSize: 12 }}>Service type</span>
          <select className="select" style={{ width: "auto", minWidth: 130 }} value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as QueueTypeFilter)}>
            {TYPE_FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </label>
        <label className="stack" style={{ gap: 4 }}>
          <span className="subtle" style={{ fontSize: 12 }}>Sort by</span>
          <select
            className="select"
            style={{ width: "auto", minWidth: 150 }}
            value={sort.field ?? ""}
            onChange={(e) => setSort({ ...sort, field: (e.target.value || null) as QueueSortField | null })}
          >
            <option value="">Default (newest)</option>
            {QUEUE_COLUMNS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
        </label>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={!sort.field}
          onClick={() => setSort({ ...sort, dir: sort.dir === "asc" ? "desc" : "asc" })}
          aria-label={sort.dir === "asc" ? "Ascending" : "Descending"}
        >
          {sort.dir === "asc" ? "Asc ▲" : "Desc ▼"}
        </button>
        <details className="col-menu spacer">
          <summary className="btn btn-secondary">Columns</summary>
          <div className="col-menu-panel">
            {QUEUE_COLUMNS.map((c) => {
              const isShown = !isHidden(c.key);
              const lastVisible = isShown && visibleCols.length <= 1;
              return (
                <label key={c.key} title={lastVisible ? "At least one column must stay visible" : undefined}>
                  <input type="checkbox" checked={isShown} disabled={lastVisible} onChange={() => toggleCol(c.key)} />
                  {c.label}
                </label>
              );
            })}
          </div>
        </details>
      </div>

      {shown.length === 0 ? (
        <div className="card empty">No items match the current search or filter.</div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                {visibleCols.map((c) => (
                  <th key={c.key}>{c.label}{sort.field === c.key ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}</th>
                ))}
                <th style={{ textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id}>
                  {!isHidden("serialNumber") && <td className="mono" data-label="SN">{r.serialNumber}</td>}
                  {!isHidden("deviceName") && <td data-label="Device Name">{r.deviceName ? r.deviceName : <span className="subtle">—</span>}</td>}
                  {!isHidden("homeUnit") && <td data-label="Unit">{r.homeUnit ? r.homeUnit : <span className="subtle">—</span>}</td>}
                  {!isHidden("serviceType") && <td data-label="Service Type">{r.serviceType}</td>}
                  <td data-label="">
                    <div className="actions" style={{ justifyContent: "flex-end" }}>
                      <Link href={`/i/${r.itemId}`} className="btn btn-ghost btn-sm">View</Link>
                      <form action={completeServiceAction}>
                        <input type="hidden" name="id" value={r.id} />
                        <input type="hidden" name="itemId" value={r.itemId} />
                        <button type="submit" className="btn btn-secondary btn-sm">Mark Completed</button>
                      </form>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 2: Replace the queue page**

Replace the entire contents of `src/app/admin/queue/page.tsx`:

```tsx
import { redirect } from "next/navigation";
import { requireAdmin, AuthError } from "@/lib/authz";
import { listActiveQueue } from "@/modules/service-queue/service-queue.service";
import { serviceTypeLabel } from "@/modules/service-queue/service-queue.status";
import { ServiceQueueTable } from "@/components/ServiceQueueTable";
import type { QueueRowVM } from "@/components/service-queue-view";

export default async function AdminQueuePage() {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) redirect(e.code === "FORBIDDEN" ? "/" : "/login");
    throw e;
  }

  const rows = await listActiveQueue();
  const vms: QueueRowVM[] = rows.map((r) => ({
    id: r.id,
    itemId: r.itemId,
    serialNumber: r.item.serialNumber,
    deviceName: r.item.deviceName,
    homeUnit: r.item.homeUnit,
    serviceTypeRaw: r.serviceType,
    serviceType: serviceTypeLabel(r.serviceType, r.serviceNote),
  }));

  return (
    <div className="stack">
      <div>
        <h1 className="page-title">Service queue</h1>
        <p className="subtle">
          Items flagged as needing service. Marking an item completed removes it from
          the queue — the record is retained and can be reopened from the item page.
        </p>
      </div>
      {vms.length === 0 ? (
        <div className="card">
          <p className="subtle">The queue is empty. Items flagged &ldquo;Needs service?&rdquo; appear here.</p>
        </div>
      ) : (
        <ServiceQueueTable rows={vms} />
      )}
    </div>
  );
}
```

- [ ] **Step 3: Full green checkpoint — build, tests, lint**

Run: `npx vitest run`
Expected: PASS (all suites).
Run: `npm run build`
Expected: compiles with no type errors (all consumers now updated).
Run: `npm run lint`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/ServiceQueueTable.tsx src/app/admin/queue/page.tsx
git commit -m "feat(service-queue): item-level queue table with sort/search/filter/columns"
```

---

## Task 10: Update `CLAUDE.md` constraints + final verification

**Files:**
- Modify: `CLAUDE.md` ("Ingest & Routing Queue" section)

**Interfaces:** none (documentation).

- [ ] **Step 1: Rewrite the "Ingest & Routing Queue" section**

In `CLAUDE.md`, replace the entire `### 🤖 Ingest & Routing Queue` block with:

```markdown
### 🤖 Service Queue (item-level)
* **Needs-service flag:** Items are placed in the service queue by a per-item "Needs service?" flag captured on the hand-receipt builder (per serial) or on the item detail page. Each flagged item carries a service type: **Reimage**, **Repair**, or **Other** (with a custom message stored in `serviceNote`).
* **Item-level queue:** The queue holds one entry per item (`ServiceQueueItem`, unique `itemId`), and only items whose entry is `PENDING` appear. Each entry may be tied to the hand receipt it was flagged on (`transferId`), shown on the item detail page.
* **Mark Completed (reversible):** Removing an item from the queue sets its status to `COMPLETED` — the record is retained (never deleted) and drops off the active queue. It can be reopened to `PENDING` from the item detail page.
* **Queue view:** The `/admin/queue` view lists SN, Device Name, Unit (item home unit), Service Type, and Actions (View + Mark Completed), with search, service-type filter, sort, and user-toggleable columns.
```

- [ ] **Step 2: Verify the wording matches the shipped behavior**

Read the new section against `src/app/admin/queue/page.tsx` and `src/modules/service-queue/service-queue.service.ts`. Confirm: item-level, `PENDING`/`COMPLETED`, reversible, columns SN/Device Name/Unit/Service Type/Actions. Fix any mismatch.

- [ ] **Step 3: Final full verification**

Run: `npx vitest run`
Expected: PASS (all suites).
Run: `npm run build`
Expected: success.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: redefine service queue as item-level, needs-service-driven"
```

---

## Self-Review

**Spec coverage:**
- "Needs service?" checkbox on new receipts → Task 5 (`ServiceControls` in the builder). ✓
- Conditional service-type dropdown (Reimage/Repair/Other + custom message) → Tasks 4 (`SERVICE_TYPE_OPTIONS`), 5 (builder), 6 (item controls). ✓
- Queue filled only with `needsService = true` (PENDING) → Task 3 (`listActiveQueue where status PENDING`), Task 9 (page). ✓
- Item-level, not receipt-level → Task 1 (unique `itemId`), Task 3. ✓
- Per-item checkbox, clean UI → Task 5 (per-serial rows, controls only when checked). ✓
- Item view shows tied hand-receipt number → Task 6 (Service card "Hand receipt" row). ✓
- Queue columns SN/Device Name/Unit/Service Type/Actions → Task 8 (`QUEUE_COLUMNS`), Task 9. ✓
- Service Type shows what needs doing (custom text for Other) → Task 2 (`serviceTypeLabel`). ✓
- Actions: "Mark Completed" + View → Task 9. ✓
- Sort/search/filter like item view → Tasks 8, 9. ✓
- User-toggleable columns like item view → Tasks 7 (shared hook), 8, 9. ✓
- Repurpose existing queue + update CLAUDE.md → Tasks 1, 3, 9, 10. ✓
- Mark Completed reversible → Tasks 3 (`reopenServiceItem`), 6 (Reopen control). ✓
- Flag editable from item view → Task 6. ✓
- Unit = item home unit → Task 8/9 (`homeUnit`). ✓
- One row per item → Task 1 (`@unique itemId`), Task 3 (`upsert`). ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; every test step shows assertions. ✓

**Type consistency:** `ServiceQueueStatus` = `PENDING|COMPLETED` and `ServiceType` = `REIMAGE|REPAIR|OTHER` used verbatim across Tasks 1-9. Function names consistent: `upsertServiceRequest`, `clearServiceRequest`, `completeServiceItem`, `reopenServiceItem`, `listActiveQueue`, `getServiceRequestForItem`, `serviceTypeLabel`, `parseServiceMap`, `getCurrentOpenTransferId`, `sortQueueRows`, `filterQueueRows`, `parseQueueSort`, `parseQueueHidden`, `makeStore`, `usePersistedPref`. `QueueRowVM` shape identical in helper (Task 8), table (Task 9), and page mapping (Task 9). ✓
