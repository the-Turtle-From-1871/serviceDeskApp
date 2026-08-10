import { createHash } from "node:crypto";

/**
 * Pure leaf for the scheduled Drive import: decide whether a fetched body is
 * actually a CSV, and fingerprint it so an unchanged export can be skipped.
 *
 * No Prisma, no `server-only`, no network — the network lives in
 * `drive-import.service.ts`, so every rule below is unit-testable directly.
 */

/**
 * Ceiling on a fetched CSV body.
 *
 * NOTE — this constant already exists twice in the repo with DIFFERENT values:
 * `5_000_000` in `src/app/api/items/import/route.ts` and `5 * 1024 * 1024`
 * (5_242_880) in `src/app/admin/items/import/ImportItemsForm.tsx`, so a file
 * between the two passes the browser check and is 413'd by the API. This copy
 * matches the API route's value deliberately — the two machine-driven paths
 * agree with each other. Collapsing all three into one definition is a real
 * fix, but it changes one of the existing limits and so is a decision, not a
 * drive-by.
 */
export const MAX_CSV_BYTES = 5_000_000;

export type DriveBodyCheck =
  | { ok: true; text: string; hash: string }
  | { ok: false; reason: string };

/** Content fingerprint. Deliberately content-based rather than Drive's
 *  `modifiedTime`: an export regenerated on a schedule gets a fresh timestamp
 *  every night even when not one device changed, so a timestamp would make
 *  "is this a new export?" always true and defeat the skip entirely. */
export function csvSourceHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Classify a body fetched from a public Drive link BEFORE it reaches the CSV
 * parser.
 *
 * The case this exists for: when a link stops being readable, Google answers
 * with an HTML page rather than an error the CSV parser would notice. Handed to
 * `parseItemsCsv` that produces zero usable rows — which is exactly what an
 * unchanged fleet also produces. The import would then report success every
 * night while silently importing nothing, and the property book would go stale
 * with no failure anywhere.
 *
 * Status alone is NOT enough to catch it. Measured 2026-08-10 against the live
 * endpoint: a missing file redirects to drive.usercontent.google.com and comes
 * back **404 with `text/html`**, which the caller's `res.ok` check already
 * rejects. But the other unreadable states do not all set a failing status —
 * the large-file virus-scan interstitial is served as **HTML under HTTP 200**,
 * and a file whose sharing was revoked has historically answered with a sign-in
 * page the same way. That case was not reproducible here without a real
 * restricted file, so the body is classified as well as the status: a leading
 * `<` is refused whatever the status line claims.
 */
export function checkDriveCsvBody(text: string, contentType: string | null): DriveBodyCheck {
  // Bytes, not characters: `String.length` counts UTF-16 code units, so a body
  // of multi-byte characters would measure well under a cap it actually blows.
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_CSV_BYTES) {
    return {
      ok: false,
      reason: `The linked file is too large to import (${bytes} bytes, limit ${MAX_CSV_BYTES}).`,
    };
  }

  const trimmed = text.trim();
  if (trimmed === "") {
    return { ok: false, reason: "The linked file is empty." };
  }

  // Two independent tells, because either can be present without the other:
  // Drive has served the interstitial as `text/html` and as an untyped body,
  // and a genuinely misconfigured link can claim `text/csv` while returning
  // markup. A real CSV never starts with `<`.
  const looksHtml =
    (contentType ?? "").toLowerCase().includes("text/html") || trimmed.startsWith("<");
  if (looksHtml) {
    return {
      ok: false,
      reason:
        "The link returned a web page, not a CSV. The Drive share has most likely " +
        "been revoked, the file was deleted, or the link now requires sign-in.",
    };
  }

  return { ok: true, text, hash: csvSourceHash(text) };
}
