import { getEmailSender, type EmailSender } from "@/lib/email";
import { addressCustodyEmail } from "@/lib/email-recipients";

export type EmailItem = { make: string; model: string; serialNumber: string };

export type ReturnEmailArgs = {
  receiver: { isDcsim: boolean; name: string; email: string | null };
  receiptNumber: string;
  receiptUrl: string;
  kind: "PARTIAL" | "FULL";
  returned: EmailItem[]; // items returned in this transaction
  remaining: EmailItem[]; // items still in the customer's custody (UPDATED)
  allItems: EmailItem[]; // every item on the receipt (CLOSED)
  pdf?: Uint8Array;
};

function itemLines(items: EmailItem[]): string {
  return items.length ? items.map((i) => `  - ${i.make} ${i.model} (SN ${i.serialNumber})`).join("\n") : "  (none)";
}

// Partial return → "UPDATED": what was returned and what is still out.
function updatedBody(a: ReturnEmailArgs): string {
  return [
    `Hand receipt ${a.receiptNumber} has been updated.`,
    ``,
    `Returned:`,
    itemLines(a.returned),
    ``,
    `Not returned:`,
    itemLines(a.remaining),
    ``,
    `View or download the signed hand receipt here:`,
    a.receiptUrl,
  ].join("\n");
}

// Full return → "CLOSED": an itemized list of all items on the receipt.
function closedBody(a: ReturnEmailArgs): string {
  return [
    `Hand receipt ${a.receiptNumber} has been closed.`,
    ``,
    itemLines(a.allItems),
    ``,
    `View or download the signed hand receipt here:`,
    a.receiptUrl,
  ].join("\n");
}

// Notifies the customer of a return, copying the G6 desk, the admin inbox and the
// record addresses on the SAME message. Best-effort: a send failure is logged and
// swallowed so it never rolls back the committed return.
export async function sendReturnEmail(args: ReturnEmailArgs, deps: { sender?: EmailSender } = {}): Promise<void> {
  const sender = deps.sender ?? getEmailSender();

  // ONE message. The separate archive copy to ADMIN_INBOX_EMAIL is gone: that inbox
  // is now a CC on the same message, so a return produces one thread rather than two
  // unrelated copies of the same notice.
  const { to, cc } = addressCustodyEmail(
    [!args.receiver.isDcsim ? args.receiver.email : undefined],
    [process.env.G6_SERVICE_DESK_EMAIL, process.env.ADMIN_INBOX_EMAIL],
  );

  if (!to) {
    console.info("[return-email] no recipient (customer email, desk and record copies all unset); skipping");
    return;
  }

  const subject = args.kind === "FULL" ? `CLOSED: ${args.receiptNumber}` : `UPDATED: ${args.receiptNumber}`;
  const text = args.kind === "FULL" ? closedBody(args) : updatedBody(args);
  const attachments = args.pdf ? [{ filename: `hand-receipt-${args.receiptNumber}.pdf`, content: args.pdf }] : undefined;

  try {
    await sender.send({ to, cc, subject, text, attachments });
  } catch (e) {
    console.error(`[return-email] failed to email ${to}:`, e);
  }
}
