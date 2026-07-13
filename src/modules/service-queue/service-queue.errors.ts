export class ServiceQueueError extends Error {
  constructor(public code: "NOT_FOUND" | "INVALID_STATUS", message?: string) {
    super(message ?? code);
    this.name = "ServiceQueueError";
  }
}
