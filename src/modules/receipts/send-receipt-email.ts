import { getEmailSender, type EmailSender } from "@/lib/email";
import type { PartyInput } from "@/modules/transfers/transfers.schema";

type Args = {
  sender: PartyInput;
  receiver: PartyInput;
  receiptNumber: string;
  receiptUrl: string;
  itemSummary: string;
};

function body(a: Args, party: "sender" | "receiver"): string {
  const role = party === "sender" ? "released" : "received";
  return [
    `A hand receipt (${a.receiptNumber}) recording that you ${role} custody of`,
    `${a.itemSummary} has been generated.`,
    ``,
    `View or download it here: ${a.receiptUrl}`,
  ].join("\n");
}

// Emails each non-DCSIM party their receipt link. Best-effort: a send failure
// is logged and swallowed so it never rolls back the completed transfer.
export async function sendReceiptEmails(args: Args, deps: { sender?: EmailSender } = {}): Promise<void> {
  const sender = deps.sender ?? getEmailSender();
  const targets: Array<{ party: "sender" | "receiver"; email: string }> = [];
  if (!args.sender.isDcsim && args.sender.email) targets.push({ party: "sender", email: args.sender.email });
  if (!args.receiver.isDcsim && args.receiver.email) targets.push({ party: "receiver", email: args.receiver.email });

  await Promise.all(
    targets.map(async (t) => {
      try {
        await sender.send({
          to: t.email,
          subject: `Hand receipt ${args.receiptNumber}`,
          text: body(args, t.party),
        });
      } catch (e) {
        console.error(`[receipt-email] failed to email ${t.email}:`, e);
      }
    })
  );
}
