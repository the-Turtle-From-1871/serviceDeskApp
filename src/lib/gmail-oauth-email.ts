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

function textPart(text: string): string {
  return `Content-Type: text/plain; charset="UTF-8"${CRLF}${CRLF}${text}`;
}

function htmlPart(html: string): string {
  return `Content-Type: text/html; charset="UTF-8"${CRLF}${CRLF}${html}`;
}

function attachmentPart(a: { filename: string; content: Uint8Array }): string {
  return (
    `Content-Type: application/pdf; name="${a.filename}"${CRLF}` +
    `Content-Disposition: attachment; filename="${a.filename}"${CRLF}` +
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

  const headers = [`From: ${from}`, `To: ${msg.to}`];
  if (msg.cc) headers.push(`Cc: ${Array.isArray(msg.cc) ? msg.cc.join(", ") : msg.cc}`);
  headers.push(`Subject: ${msg.subject}`, "MIME-Version: 1.0");

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
