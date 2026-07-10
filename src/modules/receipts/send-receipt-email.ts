import { getEmailSender, type EmailSender } from "@/lib/email";
import type { PartyInput } from "@/modules/transfers/transfers.schema";

type Args = {
  sender: PartyInput;
  receiver: PartyInput;
  receiptNumber: string;
  receiptUrl: string;
  itemSummary: string;
  pdf?: Uint8Array;
};

function body(a: Args, party: "sender" | "receiver"): string {
  const role = party === "sender" ? "released" : "received";
  return [
    `Hand receipt ${a.receiptNumber} has been generated for ${a.itemSummary}, recording that you ${role} custody of this equipment.`,
    ``,
    `View or download the signed hand receipt here:`,
    a.receiptUrl,
  ].join("\n");
}

// Neutral, non-party wording for the admin/records inbox copy.
function adminBody(a: Args): string {
  return [
    `Hand receipt ${a.receiptNumber} has been generated for ${a.itemSummary}.`,
    ``,
    `View or download the signed hand receipt here:`,
    a.receiptUrl,
  ].join("\n");
}

// Emails each non-DCSIM party their receipt link. Best-effort: a send failure
// is logged and swallowed so it never rolls back the completed transfer.
export async function sendReceiptEmails(args: Args, deps: { sender?: EmailSender } = {}): Promise<void> {
  const sender = deps.sender ?? getEmailSender();
  const targets: Array<{ party: "sender" | "receiver"; email: string }> = [];
  if (!args.sender.isDcsim && args.sender.email) targets.push({ party: "sender", email: args.sender.email });
  if (!args.receiver.isDcsim && args.receiver.email) targets.push({ party: "receiver", email: args.receiver.email });

  const attachments = args.pdf ? [{ filename: `hand-receipt-${args.receiptNumber}.pdf`, content: args.pdf }] : undefined;

  await Promise.all(
    targets.map(async (t) => {
      try {
        await sender.send({
          to: t.email,
          subject: args.receiptNumber,
          text: body(args, t.party),
          attachments,
        });
      } catch (e) {
        console.error(`[receipt-email] failed to email ${t.email}:`, e);
      }
    })
  );

  // Archive a copy of every new hand receipt to the admin/records inbox.
  const adminInbox = process.env.ADMIN_INBOX_EMAIL;
  if (adminInbox) {
    try {
      await sender.send({ to: adminInbox, subject: `NEW: ${args.receiptNumber}`, text: adminBody(args), attachments });
    } catch (e) {
      console.error(`[receipt-email] failed to email admin inbox ${adminInbox}:`, e);
    }
  }
}
