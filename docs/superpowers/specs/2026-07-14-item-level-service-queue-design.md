# Item-level Service Queue — Design

**Date:** 2026-07-14
**Status:** Approved (design), ready for implementation plan

## Summary

Replace the existing **receipt-level** service queue with an **item-level** service
queue driven by a per-item "Needs service?" flag. When a hand receipt is created,
each item (serial) can be flagged as needing service and assigned a service type
(Reimage / Repair / Other-with-custom-message). Only flagged items appear in the
queue. Admins work the queue with a **Mark Completed** action (reversible), and can
also flag/unflag or change service type from an item's detail page. The queue view
mirrors the items view: sortable, searchable, filterable, with user-toggleable
columns.

This **repurposes** the current `ServiceQueueItem` model and `/admin/queue` page
rather than adding a parallel system. The `CLAUDE.md` "Ingest & Routing Queue"
constraints are rewritten to match the new definition.

## Current state (what exists today)

- `ServiceQueueItem` is **receipt-level**: one row per `Transfer`, created
  automatically for *every* receipt inside `createReceiptAction`
  (`src/app/actions/receipts.ts`) via `enqueueTransfer(t.id)`.
- Statuses are `PENDING` → `READY_TO_ISSUE`. The Admin Queue
  (`src/app/admin/queue/page.tsx`) lists receipts grouped by date with columns
  Receipt / Items / Recipient / Unit and a **"Ready to issue"** button
  (`removeFromQueue`, `src/modules/service-queue/service-queue.service.ts`).
- The items view (`/items` → `ItemSelectTable` + `src/components/items-view.ts`)
  provides the reference pattern for search (server-side `q` param), sort,
  column-toggle, all persisted to `localStorage` via a `makeStore` helper.
- Items link to receipts through `TransferItem`. The receipt builder
  (`src/app/receipts/new/ReceiptBuilderForm.tsx`) receives a flat `itemIds` list
  plus `lines` grouped by make+model with `serials[]`; serials are currently
  rendered comma-joined, not individually.

## Decisions (resolved during brainstorming)

1. **Queue model:** Repurpose the existing service queue into the new item-level
   one (not a parallel system). Update `CLAUDE.md` to match.
2. **Unit column:** Show the item's own `homeUnit` (not the recipient's unit).
3. **Mark Completed:** Retain the record (never delete), drop it off the active
   queue, and allow **reopening** it later.
4. **Flag scope:** Settable at receipt creation **and** editable from the
   individual item detail page at any time.
5. **One row per item:** An item has at most one `ServiceQueueItem`. Re-flagging
   updates the existing row.
6. **Other display:** For `serviceType = OTHER`, the Service Type column shows the
   custom message text directly.

## Data model (Prisma)

Repurpose `ServiceQueueItem` from receipt-level to item-level.

```prisma
enum ServiceType {
  REIMAGE
  REPAIR
  OTHER
}

enum ServiceQueueStatus {
  PENDING     // in the queue, needs active service
  COMPLETED   // service done; retained, dropped off active view, reversible
}

model ServiceQueueItem {
  id          String             @id @default(cuid())
  item        Item               @relation(fields: [itemId], references: [id], onDelete: Cascade)
  itemId      String             @unique          // one active/at-most-one row per item
  // The hand receipt this service is tied to. Set from the receipt at creation,
  // or from the item's current open receipt when flagged from the item page.
  // Null when the item was never transferred.
  transfer    Transfer?          @relation("TransferQueueItems", fields: [transferId], references: [id], onDelete: SetNull)
  transferId  String?
  serviceType ServiceType
  serviceNote String?            // required only when serviceType = OTHER
  status      ServiceQueueStatus @default(PENDING)
  createdAt   DateTime           @default(now())
  updatedAt   DateTime           @updatedAt

  @@index([status])
  @@index([transferId])
}
```

- `Item` gains a back-relation: `serviceQueueItem ServiceQueueItem?`.
- `Transfer.queueItems` relation is retained (now nullable-side, `onDelete: SetNull`
  so deleting/purging a receipt does not delete the service record).
- **"needsService = true"** is derived: the item has a `ServiceQueueItem` with
  status `PENDING`. No boolean is stored on `Item`.

### Migration

Existing `ServiceQueueItem` rows are the abandoned receipt-level concept (no item
link) and are discarded. The migration:

1. Adds the `ServiceType` enum and `COMPLETED` value; removes `READY_TO_ISSUE`.
2. Restructures `ServiceQueueItem`: delete existing rows, add `itemId` (unique FK),
   `serviceType`, `serviceNote`; make `transferId` nullable.

Because there is a live Supabase production DB and a **migrate-before-push** deploy
rule, the implementation writes durable prod SQL and the row-discard is confirmed
with the user before applying. (See project memory: live-hosting, open-followups.)

## Components

### A. Pure logic — `src/modules/service-queue/service-queue.status.ts`

- Replace `READY_TO_ISSUE`/`canRemoveFromQueue`/`statusAfterRemoval` with
  `COMPLETED` equivalents: `isActiveQueueStatus` (PENDING only), `canComplete`
  (PENDING → COMPLETED), `canReopen` (COMPLETED → PENDING).
- `serviceTypeLabel(type, note): string` → `"Reimage"`, `"Repair"`, or the trimmed
  custom `note` for `OTHER`. No Prisma runtime import (stays unit-testable).

### B. Service layer — `src/modules/service-queue/service-queue.service.ts`

Item-level operations (all admin-guarded at the action layer):

- `upsertServiceRequest(itemId, { serviceType, note, transferId })` — create or
  update the item's row, set status `PENDING`. Validates `note` present for `OTHER`.
- `clearServiceRequest(itemId)` — delete the item's row (unflag).
- `completeServiceItem(id)` — `PENDING → COMPLETED` (guarded by `canComplete`).
- `reopenServiceItem(id)` — `COMPLETED → PENDING` (guarded by `canReopen`).
- `listActiveQueue()` — `PENDING` rows, `include` item (`serialNumber`,
  `deviceName`, `homeUnit`) and transfer (`receiptNumber`).
- `getServiceRequestForItem(itemId)` — for the item detail card.

The receipt action reuses `upsertServiceRequest` per flagged item; the old
receipt-level `enqueueTransfer` is removed.

`ServiceQueueError` codes extended as needed (`NOT_FOUND`, `INVALID_STATUS`,
`NOTE_REQUIRED`).

### C. Receipt intake — per-item "Needs service?" capture

- **`receipt-lines.ts` / `receipts/new/page.tsx`:** thread the per-serial `itemId`
  into the builder so each serial can be rendered and posted individually. Extend
  the builder's line shape to carry `{ serialNumber, itemId }[]` instead of a bare
  `serials: string[]`.
- **`ReceiptBuilderForm.tsx`:** render each serial on its own row with a
  **"Needs service?"** checkbox. Checked → reveal a service-type `<select>`
  (Reimage / Repair / Other); `Other` → reveal a custom-message text input.
  Unchecked serials render just the serial (UI stays clean). Fields posted as
  `service[<itemId>][needs|type|note]`.
- **`receipts.parse.ts`:** collect the per-item service map from the form.
- **`createReceiptAction`:** after the transfer is created, `upsertServiceRequest`
  for each flagged item (tied to the new receipt). Best-effort like the current
  enqueue — a service-queue hiccup must not fail the already-created receipt.

### D. Individual item view — `src/app/i/[itemId]/page.tsx`

- Add a **"Service" card** showing: needs-service status, service type
  (via `serviceTypeLabel`), and the **hand-receipt number the item is tied to**
  (linked to `/receipts/<n>`), from the `ServiceQueueItem.transfer`.
- **Admin-only controls** on the card: flag/unflag (`upsertServiceRequest` /
  `clearServiceRequest`), change service type, and **Mark Completed / Reopen**
  (`completeServiceItem` / `reopenServiceItem`). This is where reopen lives, so the
  queue view stays uncluttered. When flagged from here, `transferId` is the item's
  current open transfer (most recent `OPEN`), or `null` if none.
- Server actions live in `src/app/admin/actions/queue.ts` (extended).

### E. Service queue view — `src/app/admin/queue/page.tsx`

- Server component loads `listActiveQueue()` and maps to rows; renders a new
  **`ServiceQueueTable`** client component. Date-grouping is removed.
- Columns: **SN · Device Name · Unit (`homeUnit`) · Service Type · Actions**. Only
  `PENDING` items shown.
- **Actions:** **View** (→ `/i/[itemId]`) and **Mark Completed**
  (`completeServiceItem`).
- **`src/components/service-queue-view.ts`** (parallels `items-view.ts`): column
  defs (`sn`, `deviceName`, `homeUnit`, `serviceType`), row type, sort, and
  `localStorage` parsing. Keys: `queue:sort`, `queue:hiddenCols`.
- Search (client-side) matches SN / Device Name / Unit. **Filter** is a Service-Type
  dropdown (All / Reimage / Repair / Other). Each of the four data columns is
  individually toggleable; Actions is always shown.
- **Refactor:** extract the `makeStore` / `usePersistedPref` `localStorage` helper
  out of `ItemSelectTable.tsx` into a small shared module so both tables reuse it.

### F. `CLAUDE.md`

Rewrite the "Ingest & Routing Queue" section so the documented constraints describe
the item-level, needs-service-gated queue and the Mark-Completed (reversible)
lifecycle, replacing the all-receipts-auto-route + "Ready to issue" language.

## Testing

- **Unit:** `serviceTypeLabel`; status guards (`canComplete`/`canReopen`);
  per-item service form parsing in `receipts.parse.ts`.
- **Integration (Vitest):** flagging at receipt creation creates a `PENDING` row
  tied to the receipt; `upsertServiceRequest` updates the single row (one-per-item);
  `clearServiceRequest` unflags; `completeServiceItem`/`reopenServiceItem` toggle
  status and queue membership; `listActiveQueue` returns only `PENDING` with the
  expected includes; `OTHER` requires a note.
- **E2E (optional, Playwright):** create a receipt with a flagged item → it appears
  in the queue → Mark Completed removes it → item page shows completed + reopen.

## Out of scope

- No boolean `needsService` column on `Item` (derived from queue membership).
- No configurable/admin-managed list of service types beyond Reimage / Repair /
  Other (custom message).
- No bulk complete/flag actions.
- No notifications on service events.
