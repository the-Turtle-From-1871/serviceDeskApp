export class ReturnError extends Error {
  constructor(public code: "NOT_FOUND" | "CLOSED" | "INVALID", message?: string) {
    super(message ?? code);
    this.name = "ReturnError";
  }
}
