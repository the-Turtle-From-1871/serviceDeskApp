import { getEmailSender, type EmailSender } from "@/lib/email";
import type { PartyInput } from "@/modules/transfers/transfers.schema";

export type EmailItem = { make: string; model: string; serialNumber: string };

type Args = {
  sender: PartyInput;
  receiver: PartyInput;
  receiptNumber: string;
  receiptUrl: string;
  items: EmailItem[];
  pdf?: Uint8Array;
};

function itemLines(items: EmailItem[]): string {
  return items.length ? items.map((i) => `  - ${i.make} ${i.model} (SN ${i.serialNumber})`).join("\n") : "  (none)";
}

function body(a: Args): string {
  return [
    `New hand receipt ${a.receiptNumber} has been created.`,
    ``,
    itemLines(a.items),
    ``,
    `View or download the signed hand receipt here:`,
    a.receiptUrl,
  ].join("\n");
}

// Emails each non-DCSIM party — plus the admin/records inbox when configured —
// the new-receipt notice (subject "NEW: <HR>"). Best-effort: a send failure is
// logged and swallowed so it never rolls back the completed transfer.
export async function sendReceiptEmails(args: Args, deps: { sender?: EmailSender } = {}): Promise<void> {
  const sender = deps.sender ?? getEmailSender();

  const recipients: string[] = [];
  if (!args.sender.isDcsim && args.sender.email) recipients.push(args.sender.email);
  if (!args.receiver.isDcsim && args.receiver.email) recipients.push(args.receiver.email);
  const adminInbox = process.env.ADMIN_INBOX_EMAIL;
  if (adminInbox) recipients.push(adminInbox);

  const subject = `NEW: ${args.receiptNumber}`;
  const text = body(args);
  const attachments = args.pdf ? [{ filename: `hand-receipt-${args.receiptNumber}.pdf`, content: args.pdf }] : undefined;

  await Promise.all(
    recipients.map(async (to) => {
      try {
        await sender.send({ to, subject, text, attachments });
      } catch (e) {
        console.error(`[receipt-email] failed to email ${to}:`, e);
      }
    })
  );
}
