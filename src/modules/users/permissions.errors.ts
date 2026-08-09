export type PermissionRequestErrorCode =
  | "ALREADY_HELD"
  | "ALREADY_PENDING"
  | "NOT_FOUND"
  | "ALREADY_DECIDED"
  | "SELF_DECISION"
  | "REASON_REQUIRED";

export class PermissionRequestError extends Error {
  constructor(public code: PermissionRequestErrorCode) {
    super(code);
    this.name = "PermissionRequestError";
  }
}
