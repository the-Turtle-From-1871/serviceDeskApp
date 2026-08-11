import "server-only"; // fetches and writes the property book — never bundle to the client
import prisma from "@/lib/prisma";
import { commitImport } from "./items.service";
import { getImportActor } from "./import-actor";
import { checkDriveCsvBody, MAX_CSV_BYTES } from "./drive-csv";
import type { SkippedRow } from "./import";

/**
 * Scheduled pull of the MDM export from a public Google Drive link.
 *
 * Exists because the government workstation that produces the export cannot
 * reach this app at all — its web filter refuses the domain — so the CSV is
 * published to Drive from there and collected here instead of pushed.
 *
 * See `docs/SECURITY.md` for the accepted risk this carries: the linked file is
 * shared "anyone with the link", so the export (serials, UICs, holder names and
 * emails) is readable by anyone holding that URL.
 */

export type DriveImportResult =
  | { status: "disabled" }
  | { status: "unchanged"; hash: string }
  | {
      status: "imported";
      hash: string;
      added: number;
      updated: number;
      unchanged: number;
      skipped: SkippedRow[];
      mismatches: { serialNumber: string }[];
    };

export class DriveImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DriveImportError";
  }
}

/**
 * Ceiling on the Drive round trip.
 *
 * Sized against the SAME budget the POST /api/items/import route documents:
 * `maxDuration` (60s) must cover pre-transaction work PLUS commitImport's
 * maxWait + timeout (5 + 40 = 45s). This fetch is new pre-transaction work on
 * top of getImportActor, loadExistingBySerial and loadUnitMap, so it is kept
 * deliberately short. Failing fast here is the good outcome: the sweep reports
 * a clean error and tomorrow's run retries, whereas a slow fetch that pushes
 * the invocation past 60s gets the function killed mid-transaction.
 */
const FETCH_TIMEOUT_MS = 10_000;

/** Resolve the configured source. Returns null when unset, which makes the
 *  whole sweep a no-op rather than an error — the cron can legitimately be
 *  scheduled before anyone has published the link. */
function configuredUrl(): URL | null {
  const raw = process.env.DRIVE_CSV_URL?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DriveImportError("DRIVE_CSV_URL is not a valid URL.");
  }
  // The URL is fixed in the environment and never supplied by a request, so
  // this is not an SSRF boundary — but refusing plaintext still matters: the
  // export travels over the public internet and carries the whole property
  // book.
  if (url.protocol !== "https:") {
    throw new DriveImportError("DRIVE_CSV_URL must be an https:// URL.");
  }
  return url;
}

/** The fingerprint of the most recent Drive-sourced import.
 *
 *  Compares against the NEWEST non-null hash rather than asking "have we ever
 *  seen this content?": re-publishing an older export is a deliberate rollback
 *  and must be allowed to import, not silently skipped as a duplicate. */
async function lastImportedHash(): Promise<string | null> {
  const last = await prisma.importBatch.findFirst({
    where: { sourceHash: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { sourceHash: true },
  });
  return last?.sourceHash ?? null;
}

async function fetchCsv(url: URL): Promise<{ text: string; contentType: string | null }> {
  let res: Response;
  try {
    res = await fetch(url, {
      // Redirects are followed on purpose: Drive's download link bounces to
      // drive.usercontent.google.com. Safe here only because the starting URL
      // comes from the environment, never from a caller.
      redirect: "follow",
      cache: "no-store",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    const reason = e instanceof Error && e.name === "TimeoutError"
      ? `Drive did not respond within ${FETCH_TIMEOUT_MS / 1000}s.`
      : "Could not reach the Drive link.";
    throw new DriveImportError(reason);
  }

  if (!res.ok) {
    throw new DriveImportError(`The Drive link returned HTTP ${res.status}.`);
  }

  // Cheap pre-check on the DECLARED length, before buffering the body — the
  // same ordering the upload route uses. Drive often omits it on a redirected
  // download, so a missing or non-numeric value skips this check rather than
  // failing, and checkDriveCsvBody's real byte count is the backstop.
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_CSV_BYTES) {
    throw new DriveImportError(
      `The linked file is too large to import (${declared} bytes, limit ${MAX_CSV_BYTES}).`,
    );
  }

  return { text: await res.text(), contentType: res.headers.get("content-type") };
}

/**
 * Fetch the linked export and import it if its contents changed.
 *
 * `now` is injected so the generated batch filename is deterministic in tests.
 */
export async function importItemsFromDrive(now: Date = new Date()): Promise<DriveImportResult> {
  const url = configuredUrl();
  if (!url) return { status: "disabled" };

  const { text, contentType } = await fetchCsv(url);

  const check = checkDriveCsvBody(text, contentType);
  if (!check.ok) throw new DriveImportError(check.reason);

  const previous = await lastImportedHash();
  if (previous === check.hash) return { status: "unchanged", hash: check.hash };

  // Attributed to the same non-loginable service account the push-based import
  // uses, so automated edits never read as a person's work. Throws loudly if
  // the account is missing rather than substituting anyone else.
  const actor = await getImportActor();
  const filename = `drive-import-${now.toISOString().slice(0, 10)}.csv`;

  // homeUnit comes from the CSV column only and is never derived from the
  // device name, so an import has no vocabulary to consult and nothing to
  // resolve (removed 2026-08-11; see planImport). A blank cell leaves the home
  // unit blank, and /admin/units lists the devices in that state.
  const res = await commitImport(check.text, filename, actor, check.hash);
  if (res.error) throw new DriveImportError(res.error);

  return {
    status: "imported",
    hash: check.hash,
    added: res.added,
    updated: res.updated,
    unchanged: res.unchanged,
    skipped: res.skipped,
    mismatches: res.mismatches,
  };
}
