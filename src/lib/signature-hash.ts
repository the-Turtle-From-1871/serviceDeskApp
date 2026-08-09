import { createHash } from "node:crypto";

// Content address for a signature image. Pure and dependency-free (its own leaf
// file, like readiness.ts) so it unit-tests without a database.
//
// The encoding is load-bearing and must not be "simplified": lowercase hex of the
// SHA-256 over the string's UTF-8 bytes. The backfill migration computes the same
// value in SQL as `encode(sha256(convert_to(col, 'UTF8')), 'hex')`, and rows
// written by the app must land on the SAME key as rows written by that migration
// — otherwise an image already in the store is inserted a second time under a
// different key and the deduplication silently stops working.
export function signatureSha256(image: string): string {
  return createHash("sha256").update(image, "utf8").digest("hex");
}

/** Byte length of the stored image, matching the migration's `octet_length(convert_to(...))`. */
export function signatureByteLen(image: string): number {
  return Buffer.byteLength(image, "utf8");
}
