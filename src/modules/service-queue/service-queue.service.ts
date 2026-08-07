import type { Prisma, ServiceQueueItem, ServiceType } from "@prisma/client";
import prisma from "@/lib/prisma";
import { canComplete, canReopen } from "./service-queue.status";
import { ServiceQueueError } from "./service-queue.errors";
import { computeServiceDueAt, serviceDueAtUpdate } from "./sla";

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
