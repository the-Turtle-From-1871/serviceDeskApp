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
