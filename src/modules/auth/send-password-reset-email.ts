import { getEmailSender, type EmailSender } from "@/lib/email";

export type PasswordResetEmailArgs = { to: string; name: string; resetUrl: string };

// Emails a password-reset link. Errors propagate so the caller decides how to
// handle them (the request action logs and still returns a generic response).
export async function sendPasswordResetEmail(
  args: PasswordResetEmailArgs,
  deps: { sender?: EmailSender } = {},
): Promise<void> {
  const sender = deps.sender ?? getEmailSender();
  const text = [
    `Hello${args.name ? ` ${args.name}` : ""},`,
    ``,
    `A password reset was requested for your DCSIM Service Desk account.`,
    ``,
    `Reset your password using the link below (it expires in 1 hour):`,
    args.resetUrl,
    ``,
    `If you didn't request this, you can ignore this email — your password won't change.`,
  ].join("\n");
  await sender.send({ to: args.to, subject: "Reset your DCSIM Service Desk password", text });
}
