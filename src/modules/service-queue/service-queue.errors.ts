export class ServiceQueueError extends Error {
  constructor(public code: "NOT_FOUND" | "INVALID_STATUS" | "NOTE_REQUIRED" | "TOO_MANY", message?: string) {
    super(message ?? code);
    this.name = "ServiceQueueError";
  }
}
