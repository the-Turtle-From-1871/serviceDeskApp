import { getEmailSender, type EmailSender, escapeHtml } from "@/lib/email";

export type PasswordResetEmailArgs = { to: string; name: string; resetUrl: string };

// Emails a password-reset link as a multipart (text + HTML) message. A proper
// HTML body — a real button and clear sender identity — lands in the inbox far
// more reliably than a plain-text email whose only content is a tokenized link.
// Errors propagate so the caller decides how to handle them.
export async function sendPasswordResetEmail(
  args: PasswordResetEmailArgs,
  deps: { sender?: EmailSender } = {},
): Promise<void> {
  const sender = deps.sender ?? getEmailSender();
  const greeting = args.name ? `Hello ${args.name},` : "Hello,";

  const text = [
    greeting,
    ``,
    `A password reset was requested for your DCSIM Service Desk account.`,
    ``,
    `Reset your password using the link below (it expires in 1 hour):`,
    args.resetUrl,
    ``,
    `If you didn't request this, you can ignore this email — your password won't change.`,
  ].join("\n");

  const url = escapeHtml(args.resetUrl);
  const html = [
    `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.5;color:#0f172a;max-width:480px;margin:0 auto;padding:8px">`,
    `<p style="font-weight:600;font-size:16px;margin:0 0 12px">DCSIM Service Desk</p>`,
    `<p style="margin:0 0 12px">${escapeHtml(greeting)}</p>`,
    `<p style="margin:0 0 16px">A password reset was requested for your DCSIM Service Desk account.</p>`,
    `<p style="margin:0 0 20px"><a href="${url}" style="display:inline-block;background:#4f46e5;color:#ffffff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:600">Reset your password</a></p>`,
    `<p style="margin:0 0 16px;color:#64748b;font-size:13px">This link expires in 1 hour. If the button doesn&rsquo;t work, paste this address into your browser:<br><a href="${url}" style="color:#4f46e5;word-break:break-all">${url}</a></p>`,
    `<p style="margin:0;color:#64748b;font-size:13px">If you didn&rsquo;t request this, you can ignore this email &mdash; your password won&rsquo;t change.</p>`,
    `</div>`,
  ].join("");

  await sender.send({ to: args.to, subject: "Reset your DCSIM Service Desk password", text, html });
}
