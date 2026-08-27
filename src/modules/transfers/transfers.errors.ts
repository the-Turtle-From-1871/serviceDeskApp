export class TransferError extends Error {
  constructor(public code: "ITEM_NOT_FOUND" | "ITEM_RETIRED" | "TOO_MANY_LINES" | "CLOSED") {
    super(code);
    this.name = "TransferError";
  }
}
