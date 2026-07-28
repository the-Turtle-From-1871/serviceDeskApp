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
export async function upsertServiceRequest(input: UpsertInput): Promise<ServiceQueueItem> {
  const serviceNote = normalizeNote(input.serviceType, input.note);
  const transferId = input.transferId ?? null;
  const now = new Date();
  return prisma.serviceQueueItem.upsert({
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
export async function setServiceDeadline(itemId: string, days: number | null, now: Date = new Date()): Promise<void> {
  const res = await prisma.serviceQueueItem.updateMany({
    where: { itemId },
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

// COMPLETED -> PENDING (reopen from the item detail page). An optional per-reopen
// days value restarts the SLA clock at `now + days`; blank LEAVES THE STORED
// DEADLINE ALONE (serviceDueAtUpdate) rather than wiping it, so reopening to
// resume a job does not silently discard the date it was working to. Clearing is
// a separate, deliberate press of the deadline control.
//
// overdueAlertedAt is cleared either way — unlike upsertServiceRequest, because
// reopening genuinely starts a new round of service and the previous round's
// alert must not suppress the next one. Guarded; never resurrects a missing or
// non-COMPLETED row.
export function reopenServiceItem(id: string, overrideDays?: number | null): Promise<ServiceQueueItem> {
  return transition(id, canReopen, "PENDING", () => ({
    ...serviceDueAtUpdate(overrideDays),
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
