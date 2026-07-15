export class SignatureError extends Error {
  constructor(public code: "NOT_FOUND" | "DUPLICATE_NAME", message?: string) {
    super(message ?? code);
    this.name = "SignatureError";
  }
}
