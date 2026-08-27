import "server-only"; // reads a mailbox and writes the property book — never bundle to the client
import prisma from "@/lib/prisma";
import { commitImport } from "./items.service";
import { getImportActor } from "./import-actor";
import { checkDriveCsvBody, MAX_CSV_BYTES } from "./drive-csv";
import type { SkippedRow } from "./import";

/**
 * Scheduled collection of the MDM export from an emailed CSV attachment.
 *
 * The fourth import SOURCE, not a fourth importer: parsing and writing are
 * `commitImport`, exactly as the three existing doors use. This file is
 * modelled on `drive-import.service.ts` and differs only in where the bytes
 * come from — read that one first, its comments explain the shared decisions
 * (the hash-and-skip, the service-account attribution, the size ceiling).
 *
 * SECURITY. This is an unauthenticated trigger in the sense that anyone can
 * send mail to the inbox, so the sender check IS the boundary: a message must
 * come from an allow-listed address AND carry Gmail's own `dmarc=pass` verdict.
 * Both, never either — a `From:` header is trivially forged, and the DMARC
 * result is computed by Gmail before we ever see the message, so forging it
 * means defeating the sending domain's DMARC rather than editing a string.
 * Widening this (dropping DMARC, matching on subject alone, accepting any
 * sender) turns "whoever can send an email" into "whoever can rewrite the
 * property book".
 */

export type GmailImportResult =
  | { status: "disabled" }
  | { status: "none" }
  | { status: "unchanged"; hash: string; superseded: number }
  | {
      status: "imported";
      hash: string;
      from: string;
      superseded: number;
      added: number;
      updated: number;
      unchanged: number;
      skipped: SkippedRow[];
      mismatches: { serialNumber: string }[];
    };

export class GmailImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GmailImportError";
  }
}

/** Applied to a message once it has been imported — or deliberately passed
 *  over as superseded — so the next sweep cannot see it again. This is what
 *  stops an older export being picked up later and overwriting a newer one. */
const IMPORTED_LABEL = "MDM-Imported";

/** Applied to a message that failed the SENDER check. Deliberately a different
 *  label rather than reusing the one above: a rejected message must not be
 *  retried every sweep, but it must stay visible in Gmail as something a human
 *  should look at, not filed away as though it had been imported. */
const REJECTED_LABEL = "MDM-Import-Rejected";

/** Same reasoning as the Drive fetch's timeout: this is pre-transaction work
 *  inside the route's 60s ceiling, which must also cover commitImport's
 *  maxWait + timeout (5 + 40 = 45s). Failing fast is the good outcome — the
 *  next sweep retries, whereas a slow read gets the invocation killed
 *  mid-transaction. */
const API_TIMEOUT_MS = 10_000;

/** How far back a sweep will look. A bound, not a policy: without it a first
 *  run against a long-lived mailbox would consider years of mail. */
const LOOKBACK = "newer_than:30d";

type Config = { senders: string[]; subject: string };

/** Resolve the configuration. Returns null when unset, which makes the whole
 *  sweep a silent no-op rather than an error — the task can legitimately be
 *  scheduled before anyone has decided who may send. */
function configured(): Config | null {
  const senders = (process.env.MAIL_IMPORT_SENDERS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const subject = (process.env.MAIL_IMPORT_SUBJECT ?? "").trim();
  if (senders.length === 0 || !subject) return null;
  return { senders, subject };
}

// --- Gmail API ---------------------------------------------------------------

type GmailPart = {
  filename?: string;
  mimeType?: string;
  body?: { size?: number; attachmentId?: string };
  parts?: GmailPart[];
};
type GmailMessage = {
  id: string;
  payload: { headers: { name: string; value: string }[] } & GmailPart;
};

async function accessToken(): Promise<string> {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new GmailImportError("Gmail credentials are not configured.");
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  const json = (await res.json()) as { access_token?: string; error?: string };
  if (!res.ok || !json.access_token) {
    // Names the OAuth error code (invalid_grant, deleted_client) and nothing
    // else — never the token itself.
    throw new GmailImportError(`Gmail auth failed: ${json.error ?? res.status}`);
  }
  return json.access_token;
}

async function gmail<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init?.headers },
      cache: "no-store",
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (e) {
    throw new GmailImportError(
      e instanceof Error && e.name === "TimeoutError"
        ? `Gmail did not respond within ${API_TIMEOUT_MS / 1000}s.`
        : "Could not reach Gmail.",
    );
  }
  if (!res.ok) throw new GmailImportError(`Gmail returned HTTP ${res.status} for ${path.split("?")[0]}.`);
  return (await res.json()) as T;
}

/** Find (or create) a label id. Creating is idempotent: a concurrent sweep that
 *  wins the race makes this one's create fail, and re-reading finds the label
 *  it made. */
async function labelId(token: string, name: string): Promise<string> {
  const { labels } = await gmail<{ labels?: { id: string; name: string }[] }>(token, "/labels");
  const found = (labels ?? []).find((l) => l.name === name);
  if (found) return found.id;
  try {
    const made = await gmail<{ id: string }>(token, "/labels", {
      method: "POST",
      body: JSON.stringify({ name, labelListVisibility: "labelShow", messageListVisibility: "show" }),
    });
    return made.id;
  } catch {
    const retry = await gmail<{ labels?: { id: string; name: string }[] }>(token, "/labels");
    const now = (retry.labels ?? []).find((l) => l.name === name);
    if (!now) throw new GmailImportError(`Could not create the ${name} label.`);
    return now.id;
  }
}

async function addLabel(token: string, messageId: string, id: string, alsoRead = false): Promise<void> {
  await gmail(token, `/messages/${messageId}/modify`, {
    method: "POST",
    body: JSON.stringify({ addLabelIds: [id], removeLabelIds: alsoRead ? ["UNREAD"] : [] }),
  });
}

const header = (m: GmailMessage, name: string): string =>
  m.payload.headers.find((h) => h.name.toLowerCase() === name)?.value ?? "";

/** The bare address out of a `From:` value, which may be `Name <a@b>` or `a@b`. */
function fromAddress(value: string): string {
  const angled = value.match(/<([^>]+)>/);
  return (angled ? angled[1] : value).trim().toLowerCase();
}

/**
 * Is this message genuinely from an allow-listed sender?
 *
 * Two independent conditions, both required. `dmarc=pass` is Gmail's verdict,
 * stamped on receipt — we are reading its conclusion, not re-deriving it.
 *
 * NOTE: Gmail does NOT stamp Authentication-Results on mail the account sent to
 * itself, so a self-addressed test message fails this check. That is correct
 * behaviour, not a bug to work around: an unauthenticated message is exactly
 * what this rejects.
 */
function senderAllowed(m: GmailMessage, senders: string[]): { ok: true } | { ok: false; reason: string } {
  const from = fromAddress(header(m, "from"));
  if (!senders.includes(from)) return { ok: false, reason: `sender ${from || "(none)"} is not allow-listed` };
  const auth = header(m, "authentication-results").toLowerCase();
  if (!auth) return { ok: false, reason: `no Authentication-Results header from ${from}` };
  if (!/dmarc=pass/.test(auth)) return { ok: false, reason: `DMARC did not pass for ${from}` };
  return { ok: true };
}

/** Depth-first walk for the first `.csv` attachment part. */
function findCsvPart(part: GmailPart): GmailPart | null {
  if (part.filename && /\.csv$/i.test(part.filename) && part.body?.attachmentId) return part;
  for (const child of part.parts ?? []) {
    const hit = findCsvPart(child);
    if (hit) return hit;
  }
  return null;
}

async function downloadCsv(token: string, messageId: string, part: GmailPart): Promise<string> {
  // Cheap pre-check on the DECLARED size before pulling the body, mirroring the
  // Drive fetch. checkDriveCsvBody's real byte count remains the backstop.
  const declared = part.body?.size ?? 0;
  if (declared > MAX_CSV_BYTES) {
    throw new GmailImportError(`The attachment is too large to import (${declared} bytes, limit ${MAX_CSV_BYTES}).`);
  }
  const att = await gmail<{ data?: string }>(token, `/messages/${messageId}/attachments/${part.body!.attachmentId}`);
  if (!att.data) throw new GmailImportError("The attachment had no content.");
  return Buffer.from(att.data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

/** The fingerprint of the most recent import from ANY source. Same query the
 *  Drive sweep uses, and deliberately shared: re-sending content that was
 *  already imported — by mail or by link — is not a new export. */
async function lastImportedHash(): Promise<string | null> {
  const last = await prisma.importBatch.findFirst({
    where: { sourceHash: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { sourceHash: true },
  });
  return last?.sourceHash ?? null;
}

// --- The sweep ---------------------------------------------------------------

/**
 * Import the newest emailed export, and retire any older ones.
 *
 * `now` is injected so the generated batch filename is deterministic.
 */
export async function importItemsFromMail(now: Date = new Date()): Promise<GmailImportResult> {
  const config = configured();
  if (!config) return { status: "disabled" };

  const token = await accessToken();
  const imported = await labelId(token, IMPORTED_LABEL);

  // Gmail returns newest first. The `-label:` term is what makes a sweep
  // idempotent: anything already handled is invisible here.
  const query = [
    "has:attachment",
    "filename:csv",
    `subject:"${config.subject.replace(/"/g, "")}"`,
    `-label:${IMPORTED_LABEL}`,
    `-label:${REJECTED_LABEL}`,
    LOOKBACK,
  ].join(" ");
  const list = await gmail<{ messages?: { id: string }[] }>(
    token,
    `/messages?q=${encodeURIComponent(query)}&maxResults=25`,
  );
  const ids = (list.messages ?? []).map((m) => m.id);
  if (ids.length === 0) return { status: "none" };

  // Newest FIRST, and only the newest is imported. Every older match is
  // labelled without being read: they are superseded exports, and importing
  // them on a later sweep would write a stale property book over a fresh one.
  const [newestId, ...olderIds] = ids;
  for (const id of olderIds) await addLabel(token, id, imported);
  const superseded = olderIds.length;

  const message = await gmail<GmailMessage>(token, `/messages/${newestId}?format=full`);

  const allowed = senderAllowed(message, config.senders);
  if (!allowed.ok) {
    // Labelled REJECTED, not IMPORTED: not retried, but visible.
    await addLabel(token, newestId, await labelId(token, REJECTED_LABEL));
    throw new GmailImportError(`Refused an emailed import: ${allowed.reason}.`);
  }

  const part = findCsvPart(message.payload);
  // NOT labelled: a malformed or missing attachment is usually fixed by
  // re-sending, and labelling would make the retry invisible.
  if (!part) throw new GmailImportError("The matching message had no .csv attachment.");

  const text = await downloadCsv(token, newestId, part);
  const check = checkDriveCsvBody(text, part.mimeType ?? null);
  if (!check.ok) throw new GmailImportError(check.reason);

  const previous = await lastImportedHash();
  if (previous === check.hash) {
    // Same content already imported. Label it so the sweep settles rather than
    // reconsidering this message every run.
    await addLabel(token, newestId, imported, true);
    return { status: "unchanged", hash: check.hash, superseded };
  }

  const actor = await getImportActor();
  const filename = `mail-import-${now.toISOString().slice(0, 10)}.csv`;
  const res = await commitImport(check.text, filename, actor, check.hash);
  if (res.error) throw new GmailImportError(res.error);

  // Only after commitImport succeeded. Labelling first would lose the message
  // if the import then failed.
  await addLabel(token, newestId, imported, true);

  return {
    status: "imported",
    hash: check.hash,
    from: fromAddress(header(message, "from")),
    superseded,
    added: res.added,
    updated: res.updated,
    unchanged: res.unchanged,
    skipped: res.skipped,
    mismatches: res.mismatches,
  };
}
