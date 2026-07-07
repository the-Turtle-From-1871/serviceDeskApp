export class TransferError extends Error {
  constructor(public code: "ITEM_NOT_FOUND" | "ITEM_RETIRED" | "TOO_MANY_LINES" | "TOO_MANY_PER_ROW") {
    super(code);
    this.name = "TransferError";
  }
}
