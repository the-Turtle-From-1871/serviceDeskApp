import { getEmailSender, type EmailSender, escapeHtml } from "@/lib/email";

export type VerificationEmailArgs = { to: string; name: string; verifyUrl: string };

// Multipart (text + HTML) for the same deliverability reason as the reset mail:
// a real button and clear sender identity lands in the inbox far more reliably
// than a plain-text body whose only content is a tokenized link. Errors
// propagate so the caller decides how to handle them.
//
// The caller builds `verifyUrl` from defaultBaseUrl() — a vercel.app link in the
// body is what broke .mil delivery before, so the origin is a delivery
// requirement rather than cosmetic.
export async function sendVerificationEmail(
  args: VerificationEmailArgs,
  deps: { sender?: EmailSender } = {},
): Promise<void> {
  const sender = deps.sender ?? getEmailSender();
  const greeting = args.name ? `Hello ${args.name},` : "Hello,";

  const text = [
    greeting,
    ``,
    `An account was created for you on the DCSIM Hand Receipt system.`,
    ``,
    `Confirm this email address to finish signing up (the link expires in 24 hours):`,
    args.verifyUrl,
    ``,
    `Until you confirm, you will not be able to sign in.`,
    ``,
    `If you didn't create this account, you can ignore this email — it cannot be used until it is confirmed.`,
  ].join("\n");

  const url = escapeHtml(args.verifyUrl);
  const html = [
    `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.5;color:#0f172a;max-width:480px;margin:0 auto;padding:8px">`,
    `<p style="font-weight:600;font-size:16px;margin:0 0 12px">DCSIM Hand Receipt</p>`,
    `<p style="margin:0 0 12px">${escapeHtml(greeting)}</p>`,
    `<p style="margin:0 0 16px">An account was created for you on the DCSIM Hand Receipt system. Confirm this email address to finish signing up.</p>`,
    `<p style="margin:0 0 20px"><a href="${url}" style="display:inline-block;background:#4f46e5;color:#ffffff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:600">Confirm your email</a></p>`,
    `<p style="margin:0 0 16px;color:#64748b;font-size:13px">This link expires in 24 hours. If the button doesn&rsquo;t work, paste this address into your browser:<br><a href="${url}" style="color:#4f46e5;word-break:break-all">${url}</a></p>`,
    `<p style="margin:0;color:#64748b;font-size:13px">If you didn&rsquo;t create this account, you can ignore this email &mdash; it cannot be used until it is confirmed.</p>`,
    `</div>`,
  ].join("");

  await sender.send({ to: args.to, subject: "Confirm your DCSIM Hand Receipt email", text, html });
}
