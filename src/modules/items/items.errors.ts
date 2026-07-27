export class ItemError extends Error {
  constructor(
    public code: "NOT_FOUND" | "TOO_MANY" | "INVALID" | "DUPLICATE" | "IN_USE",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "ItemError";
  }
}
