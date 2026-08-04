import { getEmailSender, type EmailSender } from "@/lib/email";
import { addressCustodyEmail } from "@/lib/email-recipients";
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

// Sends ONE new-receipt notice (subject "NEW: <HR>") to the customer, copying the
// record addresses and the admin inbox. Best-effort: a send failure is logged and
// swallowed so it never rolls back the completed transfer.
//
// This used to send a separate message per party. See src/lib/email-recipients.ts
// for why it is one message now, and for the failure-behaviour trade that implies.
export async function sendReceiptEmails(args: Args, deps: { sender?: EmailSender } = {}): Promise<void> {
  const sender = deps.sender ?? getEmailSender();

  // ONE message, not one per party. A non-DCSIM party is a customer and belongs on
  // the To line; the record copies and the admin inbox ride along as CC.
  const { to, cc } = addressCustodyEmail(
    [
      !args.receiver.isDcsim ? args.receiver.email : undefined,
      !args.sender.isDcsim ? args.sender.email : undefined,
    ],
    [process.env.ADMIN_INBOX_EMAIL],
  );

  if (!to) {
    console.info("[receipt-email] no recipient (no party email and no record copies configured); skipping");
    return;
  }

  const subject = `NEW: ${args.receiptNumber}`;
  const text = body(args);
  const attachments = args.pdf ? [{ filename: `hand-receipt-${args.receiptNumber}.pdf`, content: args.pdf }] : undefined;

  try {
    await sender.send({ to, cc, subject, text, attachments });
  } catch (e) {
    console.error(`[receipt-email] failed to email ${to}:`, e);
  }
}
