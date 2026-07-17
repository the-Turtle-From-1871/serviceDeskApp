import type { Prisma, ServiceQueueItem, ServiceType } from "@prisma/client";
import prisma from "@/lib/prisma";
import { canComplete, canReopen } from "./service-queue.status";
import { ServiceQueueError } from "./service-queue.errors";
import { computeServiceDueAt } from "./sla";

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
export async function upsertServiceRequest(input: UpsertInput): Promise<ServiceQueueItem> {
  const serviceNote = normalizeNote(input.serviceType, input.note);
  const transferId = input.transferId ?? null;
  const dueAt = computeServiceDueAt(input.serviceType, new Date(), input.overrideDays);
  return prisma.serviceQueueItem.upsert({
    where: { itemId: input.itemId },
    create: { itemId: input.itemId, serviceType: input.serviceType, serviceNote, transferId, status: "PENDING", dueAt, overdueAlertedAt: null },
    update: { serviceType: input.serviceType, serviceNote, transferId, status: "PENDING", dueAt, overdueAlertedAt: null },
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

// COMPLETED -> PENDING (reopen from the item detail page). Restarts the SLA
// clock: recomputes dueAt from now (the service type's default, or an optional
// per-reopen override) and clears overdueAlertedAt so a fresh lapse can alert
// again — reopening means "service this again," not "undo the completion."
// Guarded; never resurrects a missing or non-COMPLETED row.
export function reopenServiceItem(id: string, overrideDays?: number | null): Promise<ServiceQueueItem> {
  return prisma.$transaction(async (tx) => {
    const current = await tx.serviceQueueItem.findUnique({ where: { id } });
    if (!current) throw new ServiceQueueError("NOT_FOUND");
    if (!canReopen(current.status)) throw new ServiceQueueError("INVALID_STATUS");
    const dueAt = computeServiceDueAt(current.serviceType, new Date(), overrideDays);
    return tx.serviceQueueItem.update({
      where: { id },
      data: { status: "PENDING", dueAt, overdueAlertedAt: null },
    });
  });
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
