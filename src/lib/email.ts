export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  cc?: string | string[];
  attachments?: { filename: string; content: Uint8Array }[];
};

export interface EmailSender {
  send(msg: EmailMessage): Promise<void>;
}

class LogEmailSender implements EmailSender {
  async send(msg: EmailMessage): Promise<void> {
    const attachmentsSuffix = msg.attachments?.length
      ? ` [attachments: ${msg.attachments.map((a) => a.filename).join(", ")}]`
      : "";
    console.info(`[email:stub] to=${msg.to}${msg.cc ? ` cc=${msg.cc}` : ""} subject=${JSON.stringify(msg.subject)}\n${msg.text}${attachmentsSuffix}`);
  }
}

class ResendEmailSender implements EmailSender {
  constructor(private apiKey: string, private from: string) {}
  async send(msg: EmailMessage): Promise<void> {
    const attachments = msg.attachments?.length
      ? msg.attachments.map((a) => ({ filename: a.filename, content: Buffer.from(a.content).toString("base64") }))
      : undefined;
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: this.from, to: msg.to, cc: msg.cc, subject: msg.subject, text: msg.text, html: msg.html, attachments }),
    });
    if (!res.ok) throw new Error(`Resend send failed: ${res.status} ${await res.text()}`);
  }
}

export function getEmailSender(): EmailSender {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (key && from) return new ResendEmailSender(key, from);
  return new LogEmailSender();
}
