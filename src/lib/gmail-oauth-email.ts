import { randomUUID } from "node:crypto";
// EmailSender arrives in Task 4 when the Gmail transport is wired up.
import type { EmailMessage } from "./email";

const CRLF = "\r\n";

function toBase64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Wrap base64 payloads at 76 columns per RFC 2045.
function wrap76(b64: string): string {
  return b64.replace(/(.{76})/g, `$1${CRLF}`);
}

// Callers build multi-line bodies with bare "\n" (e.g. Array#join("\n")); normalize
// every newline form to CRLF so the wire format never mixes line endings, without
// doubling a newline that is already CRLF.
function toCrlf(s: string): string {
  return s.replace(/\r\n|\r|\n/g, CRLF);
}

function textPart(text: string): string {
  return `Content-Type: text/plain; charset="UTF-8"${CRLF}${CRLF}${toCrlf(text)}`;
}

function htmlPart(html: string): string {
  return `Content-Type: text/html; charset="UTF-8"${CRLF}${CRLF}${toCrlf(html)}`;
}

// A header value may never contain CR or LF: either would terminate the header
// and let caller-supplied text forge new ones (an injected Bcc, a replaced
// body). Collapse both to a space rather than dropping the value, so the
// message still sends with visibly mangled — not silently altered — content.
function headerValue(v: string): string {
  return v.replace(/[\r\n]+/g, " ").trim();
}

// Non-ASCII is invalid raw in a header. Device, unit and person names can carry
// it, so encode per RFC 2047 and leave pure-ASCII subjects byte-identical.
function encodeSubject(s: string): string {
  const clean = headerValue(s);
  return /^[\x20-\x7E]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

function contentTypeFor(filename: string): string {
  switch (filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]) {
    case "pdf": return "application/pdf";
    case "csv": return "text/csv";
    case "txt": return "text/plain";
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    default: return "application/octet-stream";
  }
}

function attachmentPart(a: { filename: string; content: Uint8Array }): string {
  const name = headerValue(a.filename).replace(/"/g, "");
  return (
    `Content-Type: ${contentTypeFor(name)}; name="${name}"${CRLF}` +
    `Content-Disposition: attachment; filename="${name}"${CRLF}` +
    `Content-Transfer-Encoding: base64${CRLF}${CRLF}` +
    wrap76(Buffer.from(a.content).toString("base64"))
  );
}

// Join parts into a multipart body. Each part is preceded by its boundary
// delimiter; the block closes with the boundary plus a trailing "--".
function multipart(boundary: string, parts: string[]): string {
  return parts.map((p) => `--${boundary}${CRLF}${p}`).join(CRLF) + `${CRLF}--${boundary}--`;
}

/** Build an RFC 2822 message and return it base64url-encoded for the Gmail
 *  API `raw` field. Boundaries are injectable so tests are deterministic. */
export function buildRawEmail(
  msg: EmailMessage,
  from: string,
  boundaries: { mixed?: string; alt?: string } = {},
): string {
  const mixed = boundaries.mixed ?? `mix_${randomUUID()}`;
  const alt = boundaries.alt ?? `alt_${randomUUID()}`;

  const headers = [`From: ${headerValue(from)}`, `To: ${headerValue(msg.to)}`];
  if (msg.cc) {
    const cc = Array.isArray(msg.cc) ? msg.cc.map(headerValue).join(", ") : headerValue(msg.cc);
    headers.push(`Cc: ${cc}`);
  }
  headers.push(`Subject: ${encodeSubject(msg.subject)}`, "MIME-Version: 1.0");

  // A complete body part, headers included — so it can serve either as the
  // top-level body or as the first part inside multipart/mixed.
  const bodyPart = msg.html
    ? `Content-Type: multipart/alternative; boundary="${alt}"${CRLF}${CRLF}` +
      multipart(alt, [textPart(msg.text), htmlPart(msg.html)])
    : textPart(msg.text);

  const attachments = msg.attachments ?? [];
  const mime =
    attachments.length === 0
      ? `${headers.join(CRLF)}${CRLF}${bodyPart}`
      : `${headers.join(CRLF)}${CRLF}Content-Type: multipart/mixed; boundary="${mixed}"${CRLF}${CRLF}` +
        multipart(mixed, [bodyPart, ...attachments.map(attachmentPart)]);

  return toBase64Url(Buffer.from(mime, "utf8"));
}

export type GmailOAuthConfig = {
  from: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
};

// Refresh a minute early so a token cannot expire in flight between the check
// and Gmail receiving the request.
const SAFETY_MARGIN_MS = 60_000;

// Module scope, not instance state: getEmailSender() constructs a fresh sender
// per send, so an instance-level cache would never be reused. Keyed by the
// credentials it was minted from, so a rotated refresh token invalidates it.
let cache: { key: string; token: string; expiresAt: number } | null = null;
let inFlight: { key: string; promise: Promise<string> } | null = null;

/** Test seam: clears cached state between cases. */
export function __resetTokenCache(): void {
  cache = null;
  inFlight = null;
}

async function exchange(cfg: GmailOAuthConfig, key: string): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: cfg.refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });

  const text = await res.text();
  if (!res.ok) {
    // Every way a refresh token dies — the 7-day Testing-status expiry,
    // revocation, an account password change, 6 months idle, or exceeding 100
    // live tokens per client — arrives as this one opaque 400. Name the remedy
    // here or the log line is unactionable.
    if (text.includes("invalid_grant")) {
      throw new Error(
        "Gmail OAuth refresh token rejected (invalid_grant). Re-mint GMAIL_REFRESH_TOKEN and redeploy. " +
          "Roughly weekly is EXPECTED, not a misconfiguration: the consent screen is deliberately left in Testing " +
          "status, and Google expires a Testing-status consent grant every 7 days. Run the token-rotation tooling.",
      );
    }
    throw new Error(`Google token refresh failed: ${res.status} ${text}`);
  }

  const json = JSON.parse(text) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error("Google token refresh returned no access_token");

  const ttlMs = (json.expires_in ?? 3600) * 1000;
  cache = { key, token: json.access_token, expiresAt: Date.now() + Math.max(0, ttlMs - SAFETY_MARGIN_MS) };
  return json.access_token;
}

/** Returns a valid access token, exchanging the refresh token only when the
 *  cached one is missing, stale, or minted from different credentials.
 *  Concurrent callers share a single in-flight exchange. */
export async function getAccessToken(cfg: GmailOAuthConfig): Promise<string> {
  const key = `${cfg.clientId}:${cfg.refreshToken}`;
  if (cache && cache.key === key && cache.expiresAt > Date.now()) return cache.token;
  if (inFlight && inFlight.key === key) return inFlight.promise;

  // A rejection clears inFlight but leaves the cache untouched, so the next
  // send retries rather than inheriting a poisoned entry.
  const promise = exchange(cfg, key).finally(() => {
    if (inFlight?.key === key) inFlight = null;
  });
  inFlight = { key, promise };
  return promise;
}
