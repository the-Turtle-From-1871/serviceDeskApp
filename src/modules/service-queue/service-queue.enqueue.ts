import { PRIMARY_QUEUE_STATUS } from "./service-queue.status";

// Pure mapping from an ingested receipt (Transfer id) to the data for its
// primary service-queue entry. Every ingested receipt is routed into the queue
// in the primary/service state (PENDING) so it is processed before hitting admin
// views. Kept pure (no Prisma runtime import) so it is unit-testable.
export function toQueueItemCreateData(transferId: string) {
  return { transferId, status: PRIMARY_QUEUE_STATUS };
}
