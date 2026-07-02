import { randomBytes } from "node:crypto";

// Human-facing, non-sequential receipt id, e.g. "HR-1A2B3C4D". Non-enumerable
// by design: receipts are publicly downloadable by number.
export function generateReceiptNumber(): string {
  return `HR-${randomBytes(4).toString("hex").toUpperCase()}`;
}
