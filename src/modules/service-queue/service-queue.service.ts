import type { Prisma, ServiceQueueItem } from "@prisma/client";
import prisma from "@/lib/prisma";
import { PRIMARY_QUEUE_STATUS, READY_TO_ISSUE_STATUS, canRemoveFromQueue } from "./service-queue.status";
import { toQueueItemCreateData } from "./service-queue.enqueue";
import { ServiceQueueError } from "./service-queue.errors";

// Either the root client or a transaction client, so ingestion can optionally
// enqueue atomically inside an existing transaction.
type Db = typeof prisma | Prisma.TransactionClient;

// The trimmed Transfer fields the Admin Queue renders — never pull signature
// blobs / full PII into the list view.
const queueTransferSelect = {
  receiptNumber: true,
  itemSummary: true,
  receiverName: true,
  receiverUnit: true,
  status: true,
  createdAt: true,
} satisfies Prisma.TransferSelect;

export type QueueItemWithTransfer = ServiceQueueItem & {
  transfer: Prisma.TransferGetPayload<{ select: typeof queueTransferSelect }>;
};

// Route an ingested receipt into the primary service queue (PENDING). Accepts an
// optional db/tx client so the ingestion pipeline can enqueue atomically.
export function enqueueTransfer(transferId: string, db: Db = prisma): Promise<ServiceQueueItem> {
  return db.serviceQueueItem.create({ data: toQueueItemCreateData(transferId) });
}

// Items still requiring active service/intervention (the Admin Queue). Callers
// group these by date for display (see groupByDate).
export function listActiveQueue(): Promise<QueueItemWithTransfer[]> {
  return prisma.serviceQueueItem.findMany({
    where: { status: PRIMARY_QUEUE_STATUS },
    orderBy: { createdAt: "desc" },
    include: { transfer: { select: queueTransferSelect } },
  }) as Promise<QueueItemWithTransfer[]>;
}

// Remove an item from the Admin Queue. Never deletes — transitions the record to
// "Ready to issue when needed" (READY_TO_ISSUE) so it drops off the active view
// while being retained. Guards against re-removing an already-removed item.
export function removeFromQueue(id: string): Promise<ServiceQueueItem> {
  return prisma.$transaction(async (tx) => {
    const current = await tx.serviceQueueItem.findUnique({ where: { id } });
    if (!current) throw new ServiceQueueError("NOT_FOUND");
    if (!canRemoveFromQueue(current.status)) throw new ServiceQueueError("INVALID_STATUS");
    return tx.serviceQueueItem.update({
      where: { id },
      data: { status: READY_TO_ISSUE_STATUS },
    });
  });
}
