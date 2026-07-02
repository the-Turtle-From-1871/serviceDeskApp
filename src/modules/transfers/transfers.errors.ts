export class TransferError extends Error {
  constructor(public code: "ITEM_NOT_FOUND" | "ITEM_RETIRED" | "RECEIPT_COLLISION") {
    super(code);
    this.name = "TransferError";
  }
}
