import { randomBytes, createHash } from "node:crypto";

// A raw reset token (32 random bytes, hex). Only this raw value goes in the
// emailed link; the DB stores its hash.
export function generateResetToken(): string {
  return randomBytes(32).toString("hex");
}

// SHA-256 hex of a raw token. Stored/compared server-side so a DB leak can't be
// used to reset a password.
export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}
