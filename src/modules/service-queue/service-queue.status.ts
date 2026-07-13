import type { ServiceQueueStatus } from "@prisma/client";

// Pure status logic for the service queue. No DB / Prisma runtime import here
// (only the erased `import type`), so this is unit-testable without a database.

// Primary/service state every freshly ingested receipt lands in. Items in this
// state are shown on the Admin Queue as requiring active service/intervention.
export const PRIMARY_QUEUE_STATUS: ServiceQueueStatus = "PENDING";

// "Ready to issue when needed" — the state an item moves to when an admin
// removes it from the Admin Queue. The record is retained, never deleted.
export const READY_TO_ISSUE_STATUS: ServiceQueueStatus = "READY_TO_ISSUE";

// Whether an item in the given status currently appears on the Admin Queue
// (i.e. still requires active service/intervention).
export function isActiveQueueStatus(status: ServiceQueueStatus): boolean {
  return status === PRIMARY_QUEUE_STATUS;
}

// Guard: only active (PENDING) items can be removed from the queue. Removing an
// item already flagged "Ready to issue" is an invalid/redundant transition.
export function canRemoveFromQueue(status: ServiceQueueStatus): boolean {
  return status === PRIMARY_QUEUE_STATUS;
}

// The status an item transitions to when an admin removes it from the queue.
// Removal is a state change ("Ready to issue when needed"), never a delete.
export function statusAfterRemoval(): ServiceQueueStatus {
  return READY_TO_ISSUE_STATUS;
}
