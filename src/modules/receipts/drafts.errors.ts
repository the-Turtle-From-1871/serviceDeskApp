export type DraftErrorCode = "TOO_MANY" | "CORRUPT";

export class DraftError extends Error {
  constructor(public readonly code: DraftErrorCode) {
    super(code);
    this.name = "DraftError";
  }
}
