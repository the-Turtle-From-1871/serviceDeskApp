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
