export type TransferErrorCode =
  | "NOT_HOLDER" | "ALREADY_PENDING" | "ITEM_RETIRED" | "RECIPIENT_INVALID"
  | "NOT_RECIPIENT" | "NOT_PENDING" | "SIGNATURE_REQUIRED" | "SAME_USER";

export class TransferError extends Error {
  constructor(public code: TransferErrorCode) {
    super(code);
    this.name = "TransferError";
  }
}
