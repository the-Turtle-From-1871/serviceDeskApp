export class ContactError extends Error {
  constructor(public code: "DUPLICATE_EMAIL" | "NOT_FOUND", message?: string) {
    super(message ?? code);
    this.name = "ContactError";
  }
}
