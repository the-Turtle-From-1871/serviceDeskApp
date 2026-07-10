import { randomUUID } from "node:crypto";
import type { EmailMessage, EmailSender } from "./email";

const CRLF = "\r\n";

function toBase64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Wrap base64 payloads at 76 chars per MIME (RFC 2045).
function wrap76(b64: string): string {
  return b64.replace(/(.{76})/g, `$1${CRLF}`);
}

/** Build an RFC 2822 message and return it base64url-encoded for the Gmail
 *  API `raw` field. Plain text when there are no attachments, else
 *  multipart/mixed with each (PDF) attachment base64-encoded. */
export function buildRawEmail(msg: EmailMessage, from: string, boundary = `b_${randomUUID()}`): string {
  const headers = [`From: ${from}`, `To: ${msg.to}`];
  if (msg.cc) headers.push(`Cc: ${Array.isArray(msg.cc) ? msg.cc.join(", ") : msg.cc}`);
  headers.push(`Subject: ${msg.subject}`, "MIME-Version: 1.0");

  const attachments = msg.attachments ?? [];
  let mime: string;
  if (attachments.length === 0) {
    headers.push('Content-Type: text/plain; charset="UTF-8"');
    mime = headers.join(CRLF) + CRLF + CRLF + msg.text;
  } else {
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    const parts = [
      `--${boundary}${CRLF}Content-Type: text/plain; charset="UTF-8"${CRLF}${CRLF}${msg.text}`,
      ...attachments.map(
        (a) =>
          `--${boundary}${CRLF}` +
          `Content-Type: application/pdf; name="${a.filename}"${CRLF}` +
          `Content-Disposition: attachment; filename="${a.filename}"${CRLF}` +
          `Content-Transfer-Encoding: base64${CRLF}${CRLF}` +
          wrap76(Buffer.from(a.content).toString("base64")),
      ),
    ];
    mime = headers.join(CRLF) + CRLF + CRLF + parts.join(CRLF) + `${CRLF}--${boundary}--`;
  }
  return toBase64Url(Buffer.from(mime, "utf8"));
}

export type GmailConfig = { from: string; clientId: string; clientSecret: string; refreshToken: string };

// Sends mail as a Gmail account via the Gmail REST API. Auth is an OAuth2
// refresh token (exchanged for a short-lived access token per send). Errors
// propagate so callers/log wrappers can surface them.
export class GmailEmailSender implements EmailSender {
  constructor(private cfg: GmailConfig) {}

  private async accessToken(): Promise<string> {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        refresh_token: this.cfg.refreshToken,
        grant_type: "refresh_token",
      }).toString(),
    });
    if (!res.ok) throw new Error(`Google token refresh failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { access_token?: string };
    if (!json.access_token) throw new Error("Google token refresh returned no access_token");
    return json.access_token;
  }

  async send(msg: EmailMessage): Promise<void> {
    const raw = buildRawEmail(msg, this.cfg.from);
    const token = await this.accessToken();
    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw }),
    });
    if (!res.ok) throw new Error(`Gmail send failed: ${res.status} ${await res.text()}`);
  }
}

export function gmailConfigFromEnv(): GmailConfig | null {
  const from = process.env.GMAIL_FROM;
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
  if (from && clientId && clientSecret && refreshToken) return { from, clientId, clientSecret, refreshToken };
  return null;
}
