export class PasswordChangeError extends Error {
  constructor(public code: "INVALID_CURRENT") {
    super(code);
    this.name = "PasswordChangeError";
  }
}
