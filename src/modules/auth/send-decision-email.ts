import { getEmailSender, type EmailSender, escapeHtml } from "@/lib/email";
import { CAPABILITY_LABELS } from "@/modules/users/capabilities";
import type { Capability } from "@prisma/client";

export type DecisionEmailArgs = {
  to: string;
  name: string;
  approved: Capability[];
  denied: Capability[];
  denialReason?: string | null;
  accountUrl: string;
};

// ✓ / ✗ as TEXT characters, not icons or background colours: mail clients strip
// CSS and block images, so anything relying on either arrives as an unmarked
// list. The words "Approved"/"Denied" carry the meaning regardless, which is
// also what makes this readable to a screen reader.
const line = (mark: string, c: Capability, word: string) =>
  `  ${mark}  ${CAPABILITY_LABELS[c]} — ${word}`;

export async function sendDecisionEmail(
  args: DecisionEmailArgs,
  deps: { sender?: EmailSender } = {},
): Promise<void> {
  const sender = deps.sender ?? getEmailSender();
  const greeting = args.name ? `Hello ${args.name},` : "Hello,";
  const anyApproved = args.approved.length > 0;

  const text = [
    greeting,
    ``,
    anyApproved
      ? `Your permission request has been reviewed.`
      : `Your permission request has been reviewed and was not granted.`,
    ``,
    ...args.approved.map((c) => line("[approved]", c, "Approved")),
    ...args.denied.map((c) => line("[denied]  ", c, "Denied")),
    ...(args.denied.length > 0 && args.denialReason
      ? [``, `Reason given: ${args.denialReason}`]
      : []),
    ``,
    anyApproved ? `Anything approved is active now — you may need to reload the page.` : ``,
    `You can see your permissions here:`,
    args.accountUrl,
  ]
    .filter((l) => l !== undefined)
    .join("\n");

  const row = (c: Capability, ok: boolean) =>
    `<tr><td style="padding:4px 8px 4px 0;font-weight:600;color:${ok ? "#15803d" : "#b91c1c"}">${ok ? "&#10003;" : "&#10007;"}</td>` +
    `<td style="padding:4px 12px 4px 0">${escapeHtml(CAPABILITY_LABELS[c])}</td>` +
    `<td style="padding:4px 0;color:${ok ? "#15803d" : "#b91c1c"}">${ok ? "Approved" : "Denied"}</td></tr>`;

  const html = [
    `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.5;color:#0f172a;max-width:520px;margin:0 auto;padding:8px">`,
    `<p style="font-weight:600;font-size:16px;margin:0 0 12px">DCSIM Hand Receipt</p>`,
    `<p style="margin:0 0 12px">${escapeHtml(greeting)}</p>`,
    `<p style="margin:0 0 16px">Your permission request has been reviewed.</p>`,
    `<table style="border-collapse:collapse;margin:0 0 16px">`,
    ...args.approved.map((c) => row(c, true)),
    ...args.denied.map((c) => row(c, false)),
    `</table>`,
    args.denied.length > 0 && args.denialReason
      ? `<p style="margin:0 0 16px;padding:10px 12px;background:#fef2f2;border-radius:8px"><strong>Reason given:</strong> ${escapeHtml(args.denialReason)}</p>`
      : ``,
    `<p style="margin:0 0 16px"><a href="${escapeHtml(args.accountUrl)}" style="color:#4f46e5">See your permissions</a></p>`,
    `</div>`,
  ].join("");

  await sender.send({
    to: args.to,
    subject: anyApproved
      ? "Your permission request was approved"
      : "Your permission request was reviewed",
    text,
    html,
  });
}
