import type { Prisma, ServiceQueueItem, ServiceType } from "@prisma/client";
import prisma from "@/lib/prisma";
import { canComplete, canReopen } from "./service-queue.status";
import { ServiceQueueError } from "./service-queue.errors";
import { computeServiceDueAt, serviceDueAtUpdate } from "./sla";
import { MAX_BULK_ITEMS } from "@/modules/items/items.schema";

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

type UpsertInput = {
  itemId: string;
  serviceType: ServiceType;
  note?: string | null;
  transferId?: string | null;
  overrideDays?: number | null;
};

// Normalize the note: trimmed value or null. OTHER requires a non-empty note.
function normalizeNote(serviceType: ServiceType, note: string | null | undefined): string | null {
  const trimmed = (note ?? "").trim();
  if (serviceType === "OTHER" && !trimmed) throw new ServiceQueueError("NOTE_REQUIRED");
  return trimmed || null;
}

// Create or update the item's single service request, (re)setting it to PENDING.
// `async` so the normalizeNote NOTE_REQUIRED throw surfaces as a rejected promise
// (a sync throw would escape callers' `.rejects`/try-await handling).
//
// `overrideDays` is asymmetric between the two branches, on purpose:
//   * CREATE — blank/absent writes dueAt = NULL. A brand-new flag has no
//     deadline unless one was typed, and there is still no per-type default
//     substituted behind the user's back (see sla.ts).
//   * UPDATE — blank/absent writes NOTHING: the stored deadline is left exactly
//     as it is (serviceDueAtUpdate). Re-saving an already-flagged item to fix a
//     typo in the note or switch Repair→Reimage used to wipe its deadline,
//     because the days input renders blank and blank meant "none". A save that
//     says nothing about the deadline must not be a decision about it.
// Clearing a deadline is therefore NOT reachable from here — it belongs to
// setServiceDeadline below.
//
// `overdueAlertedAt` follows the same rule: it is re-armed only when dueAt is
// actually written. An overdue alert is per-deadline, so an unchanged deadline
// that already alerted must not re-alert because someone edited the note.
//
// THE EXCEPTION, and why the transaction below exists: "leave the deadline
// alone" is only right for a row that is ALREADY PENDING. A COMPLETED row being
// flagged again is a NEW ROUND of service on a device that broke a second time,
// and `completeServiceItem` deliberately leaves the finished round's `dueAt` and
// `overdueAlertedAt` on the row. Without the reset below, re-flagging inherited
// both: the new job opened reading "Overdue 17d" against the PREVIOUS job's
// deadline, and because the overdue sweep filters `overdueAlertedAt: null`
// (timer-alert.service.ts), that new lapse could never alert at all. So a
// COMPLETED row is wiped back to "no deadline, never alerted" first, and the
// upsert's normal rules then apply to a clean row.
export async function upsertServiceRequest(input: UpsertInput): Promise<ServiceQueueItem> {
  const serviceNote = normalizeNote(input.serviceType, input.note);
  const transferId = input.transferId ?? null;
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    // Scoped to COMPLETED, so a genuine re-save of a PENDING row is untouched
    // and still keeps its deadline. Race-safe by construction: it can only
    // clear a row that already exists, and the upsert below still owns the
    // create path and its unique-constraint handling.
    await tx.serviceQueueItem.updateMany({
      where: { itemId: input.itemId, status: "COMPLETED" },
      data: { dueAt: null, overdueAlertedAt: null },
    });
    return tx.serviceQueueItem.upsert({
      where: { itemId: input.itemId },
      create: {
        itemId: input.itemId, serviceType: input.serviceType, serviceNote, transferId, status: "PENDING",
        dueAt: computeServiceDueAt(now, input.overrideDays), overdueAlertedAt: null,
      },
      update: {
        serviceType: input.serviceType, serviceNote, transferId, status: "PENDING",
        ...serviceDueAtUpdate(input.overrideDays, now),
      },
    });
  });
}

type BulkUpsertInput = {
  itemIds: string[];
  serviceType: ServiceType;
  note?: string | null;
  overrideDays?: number | null;
};

/**
 * Flag MANY items for service in one pass — the batched twin of
 * upsertServiceRequest, for a cart of devices scanned off a shelf.
 *
 * Four queries in one transaction, never one per item. The COMPLETED wipe stays
 * AHEAD of the update for the same reason it does in the single-item path: a
 * device that broke a second time would otherwise inherit the finished round's
 * dueAt (opening as "Overdue 17d") and its overdueAlertedAt, which the sweep's
 * `overdueAlertedAt: null` filter turns into "this lapse can never alert".
 *
 * Blank days keeps its two meanings — NO deadline on create
 * (computeServiceDueAt), NO CHANGE on update (serviceDueAtUpdate returns {}) —
 * so re-flagging a live request cannot move a deadline nobody touched.
 *
 * transferId is null ON CREATE ONLY: a scanned batch has no receipt behind it,
 * matching the item-page flag rather than the receipt builder's. It is
 * deliberately ABSENT from the update, so re-flagging an item that was first
 * flagged from the hand-receipt builder keeps the receipt it came in on (the
 * item page renders that link). "This batch has no receipt" licenses a null on
 * a row being created; it is not a statement that an existing link is wrong —
 * the same principle the blank deadline follows two paragraphs up, that a save
 * saying nothing about a field must not be a decision about it.
 *
 * RETIRED items are excluded and REPORTED, not refused — see recordAudits.
 *
 * Enforces NO permissions — the calling Server Action owns the guard.
 */
export async function upsertServiceRequests(
  input: BulkUpsertInput,
): Promise<{ updated: number; skipped: number }> {
  // Throws NOTE_REQUIRED before any query, so an OTHER with no note cannot
  // half-apply across a batch.
  const serviceNote = normalizeNote(input.serviceType, input.note);

  const ids = [...new Set(input.itemIds.filter((id) => id.trim() !== ""))];
  if (ids.length === 0) return { updated: 0, skipped: 0 };
  if (ids.length > MAX_BULK_ITEMS) throw new ServiceQueueError("TOO_MANY");

  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const active = await tx.item.findMany({
      where: { id: { in: ids }, status: "ACTIVE" },
      select: { id: true },
    });
    const activeIds = active.map((a) => a.id);
    if (activeIds.length === 0) return { updated: 0, skipped: ids.length };

    const existing = await tx.serviceQueueItem.findMany({
      where: { itemId: { in: activeIds } },
      select: { itemId: true },
    });
    const existingIds = new Set(existing.map((e) => e.itemId));

    // New round resets: scoped to COMPLETED, so a genuine re-save of a PENDING
    // row keeps its deadline.
    await tx.serviceQueueItem.updateMany({
      where: { itemId: { in: activeIds }, status: "COMPLETED" },
      data: { dueAt: null, overdueAlertedAt: null },
    });

    if (existingIds.size > 0) {
      await tx.serviceQueueItem.updateMany({
        where: { itemId: { in: [...existingIds] } },
        data: {
          serviceType: input.serviceType,
          serviceNote,
          status: "PENDING",
          ...serviceDueAtUpdate(input.overrideDays, now),
        },
      });
    }

    const fresh = activeIds.filter((id) => !existingIds.has(id));
    if (fresh.length > 0) {
      await tx.serviceQueueItem.createMany({
        data: fresh.map((itemId) => ({
          itemId,
          serviceType: input.serviceType,
          serviceNote,
          transferId: null,
          status: "PENDING" as const,
          dueAt: computeServiceDueAt(now, input.overrideDays),
          overdueAlertedAt: null,
        })),
        // Race-safe against the same item being flagged elsewhere between the
        // read and the write, leaning on the unique itemId constraint.
        skipDuplicates: true,
      });
    }

    return { updated: activeIds.length, skipped: ids.length - activeIds.length };
  });
}

// Set or CLEAR the item's service deadline — the one write that can remove one,
// and the only reason blank is allowed to mean "no deadline" on an existing row.
// It is a separate, single-purpose operation for the same reason the hand-receipt
// return timer is (setReceiptDueAtAction / ReceiptDueAtControls): when the
// deadline has its own form, pressing its button is always an explicit decision
// about the deadline, and every OTHER save — service type, note, reopen — can
// leave the stored instant untouched instead of guessing.
//
// `days = null` clears; a day count sets `now + days` and re-arms the overdue
// alert. updateMany (not update) so a missing row is a `count` of 0 rather than a
// Prisma P2025 the action layer would have to sniff for.
// Scoped to PENDING: a deadline on COMPLETED work means nothing (the queue does
// not show it, the sweep does not read it), and the UI only renders this form
// for a pending request — so matching a completed row would only ever be a
// crafted POST editing finished work. A completed row therefore reports
// NOT_FOUND, same as no row at all.
export async function setServiceDeadline(itemId: string, days: number | null, now: Date = new Date()): Promise<void> {
  const res = await prisma.serviceQueueItem.updateMany({
    where: { itemId, status: "PENDING" },
    data: { dueAt: computeServiceDueAt(now, days), overdueAlertedAt: null },
  });
  if (res.count === 0) throw new ServiceQueueError("NOT_FOUND");
}

// Unflag: remove the item's service request entirely.
export async function clearServiceRequest(itemId: string): Promise<void> {
  await prisma.serviceQueueItem.delete({ where: { itemId } });
}

// PENDING -> COMPLETED. Guarded; never deletes.
//
// Also stamps the item's markedReadyAt, in the SAME transaction as the status
// change. Finishing service means the device is physically on the bench in our
// hands, which is exactly what markedReadyAt asserts — and readiness is derived
// (readiness.ts), so without this the item would drop out of IN_REPAIR straight
// back to whatever its stale MDM logon implies. Two writes, one transaction: a
// queue row that says COMPLETED while the item was never marked on hand is the
// inconsistency worth preventing.
export function completeServiceItem(id: string): Promise<ServiceQueueItem> {
  return transition(id, canComplete, "COMPLETED", undefined, (tx, current) =>
    // updateMany, not update: a retired item is out of scope for "on hand"
    // (readiness reports RETIRED regardless), and an item deleted underneath us
    // must not roll back a legitimate completion.
    tx.item.updateMany({
      where: { id: current.itemId, status: "ACTIVE" },
      data: { markedReadyAt: new Date() },
    }),
  );
}

/**
 * Complete MANY items' service in one pass — the batched twin of
 * completeServiceItem, for a cart of finished devices.
 *
 * Three queries in one transaction. The findMany replaces the single-item
 * canComplete guard: a row that is not PENDING simply is not in the set, so a
 * completed row is SKIPPED rather than erroring the whole batch.
 *
 * It is scoped to ACTIVE items as well as PENDING rows, so RETIRED kit is
 * excluded and counted in `skipped` — the cross-cutting rule every bulk action
 * here follows (see recordAudits and upsertServiceRequests). Completing a
 * ticket is a claim that a device came back to the bench, which is meaningless
 * for kit that left the fleet, and counting it in `updated` overstated what the
 * sweep achieved. The SINGLE-item path is deliberately unscoped: clearing a
 * stale ticket off a retired device is a real, deliberate act on one row.
 *
 * Steps 2 and 3 stay in one transaction for the reason the single-item version
 * gives: a queue row that says COMPLETED while the item was never marked on
 * hand is the inconsistency worth preventing. Like that version it deliberately
 * LEAVES dueAt/overdueAlertedAt on the finished row — clearing them is the next
 * round's job (upsertServiceRequests / reopenServiceItem).
 *
 * The item update is scoped to ACTIVE: "back on hand" is meaningless for kit
 * that left the fleet, and readiness reports RETIRED regardless.
 *
 * Enforces NO permissions — the calling Server Action owns the guard.
 */
export async function completeServiceItems(
  itemIds: string[],
): Promise<{ updated: number; skipped: number }> {
  const ids = [...new Set(itemIds.filter((id) => id.trim() !== ""))];
  if (ids.length === 0) return { updated: 0, skipped: 0 };
  if (ids.length > MAX_BULK_ITEMS) throw new ServiceQueueError("TOO_MANY");

  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const pending = await tx.serviceQueueItem.findMany({
      // A relation filter, not a second query: one round trip still, and a
      // retired item's ticket is never in the set to be completed.
      where: { itemId: { in: ids }, status: "PENDING", item: { status: "ACTIVE" } },
      select: { id: true, itemId: true },
    });
    if (pending.length === 0) return { updated: 0, skipped: ids.length };

    await tx.serviceQueueItem.updateMany({
      where: { id: { in: pending.map((p) => p.id) } },
      data: { status: "COMPLETED" },
    });
    await tx.item.updateMany({
      where: { id: { in: pending.map((p) => p.itemId) }, status: "ACTIVE" },
      data: { markedReadyAt: now },
    });

    return { updated: pending.length, skipped: ids.length - pending.length };
  });
}

// COMPLETED -> PENDING (reopen from the item detail page).
//
// Reopen is a NEW ROUND, exactly like re-flagging a completed row, so it follows
// the same rule: the deadline is SET from the per-reopen days value, and blank
// means no deadline. It deliberately does NOT inherit the finished round's date.
//
// An earlier version kept the stored deadline on blank, reasoning that reopening
// to resume a job should not discard the date it was working to. That is wrong
// whenever the finished round's deadline has already passed — which is the
// common case, since a job that ran late is exactly the one you reopen. It
// resurrected a lapsed date, so the item read "Overdue 17d" the instant it
// reopened, and because overdueAlertedAt is cleared here it also re-sent the
// overdue email for a deadline that had already alerted.
//
// overdueAlertedAt is cleared unconditionally, which is safe now that dueAt is
// always rewritten alongside it. Guarded; never resurrects a missing or
// non-COMPLETED row.
export function reopenServiceItem(id: string, overrideDays?: number | null): Promise<ServiceQueueItem> {
  return transition(id, canReopen, "PENDING", () => ({
    dueAt: computeServiceDueAt(new Date(), overrideDays),
    overdueAlertedAt: null,
  }));
}

// Guarded status transition in one transaction. `extra` optionally contributes
// additional update fields derived from the current row (e.g. reopen recomputing
// the SLA deadline); `sideEffect` optionally writes to ANOTHER table inside the
// same transaction (e.g. complete stamping the item's markedReadyAt) — so
// callers share the NOT_FOUND / INVALID_STATUS guards rather than
// re-implementing the findUnique+guard+update scaffold.
function transition(
  id: string,
  guard: (s: ServiceQueueItem["status"]) => boolean,
  next: ServiceQueueItem["status"],
  extra?: (current: ServiceQueueItem) => Prisma.ServiceQueueItemUpdateInput,
  sideEffect?: (tx: Prisma.TransactionClient, current: ServiceQueueItem) => Promise<unknown>,
): Promise<ServiceQueueItem> {
  return prisma.$transaction(async (tx) => {
    const current = await tx.serviceQueueItem.findUnique({ where: { id } });
    if (!current) throw new ServiceQueueError("NOT_FOUND");
    if (!guard(current.status)) throw new ServiceQueueError("INVALID_STATUS");
    const updated = await tx.serviceQueueItem.update({ where: { id }, data: { status: next, ...extra?.(current) } });
    if (sideEffect) await sideEffect(tx, current);
    return updated;
  });
}

// The active queue: PENDING rows with the fields the item table renders.
/** Hard cap on the rows the queue page ships to the client.
 *
 *  This list is NOT paginated, deliberately: production carries 9 pending
 *  entries, and `ServiceQueueTable` searches, filters and sorts them in the
 *  browser — instant on a real queue, and worth keeping that way. But an
 *  uncapped `findMany` still breaks the "bound every list" rule the moment the
 *  queue is ever left to grow, and the whole result is serialized into a Client
 *  Component, so the cap is what makes the page's cost knowable rather than
 *  proportional to a table nobody is watching.
 *
 *  200 is ~22x the live queue: high enough that truncation cannot happen in
 *  practice, low enough that the payload stays small if something goes wrong
 *  (a bad import flagging the whole fleet, say). If it is ever reached, the
 *  page SAYS SO — see `truncated`. Silently dropping rows here would be a
 *  confident wrong answer about which devices need service. */
export const QUEUE_MAX_ROWS = 200;

/**
 * The pending queue, capped.
 *
 * Takes one row MORE than the cap purely to detect overflow, which answers
 * "is there more?" without a second COUNT query on a page that otherwise runs
 * exactly one.
 */
export async function listActiveQueue(): Promise<{ rows: QueueRow[]; truncated: boolean }> {
  const rows = (await prisma.serviceQueueItem.findMany({
    where: { status: "PENDING" },
    orderBy: { createdAt: "desc" },
    include: { item: { select: queueItemSelect }, transfer: { select: queueTransferSelect } },
    take: QUEUE_MAX_ROWS + 1,
  })) as QueueRow[];
  return { rows: rows.slice(0, QUEUE_MAX_ROWS), truncated: rows.length > QUEUE_MAX_ROWS };
}

// The item's current service request (any status), for the item detail card.
export function getServiceRequestForItem(itemId: string): Promise<ItemServiceRequest | null> {
  return prisma.serviceQueueItem.findUnique({
    where: { itemId },
    include: { transfer: { select: queueTransferSelect } },
  }) as Promise<ItemServiceRequest | null>;
}
