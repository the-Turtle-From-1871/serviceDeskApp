export class ItemError extends Error {
  constructor(public code: "NOT_FOUND", message?: string) {
    super(message ?? code);
    this.name = "ItemError";
  }
}
