import { getEmailSender, type EmailSender } from "@/lib/email";

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

// Notifies the customer of a return (CC the G6 desk). Best-effort: a send
// failure is logged and swallowed so it never rolls back the committed return.
export async function sendReturnEmail(args: ReturnEmailArgs, deps: { sender?: EmailSender } = {}): Promise<void> {
  const sender = deps.sender ?? getEmailSender();
  const desk = process.env.G6_SERVICE_DESK_EMAIL;
  const customer = !args.receiver.isDcsim && args.receiver.email ? args.receiver.email : undefined;
  const to = customer ?? desk;

  const subject = args.kind === "FULL" ? `CLOSED: ${args.receiptNumber}` : `UPDATED: ${args.receiptNumber}`;
  const text = args.kind === "FULL" ? closedBody(args) : updatedBody(args);
  const attachments = args.pdf ? [{ filename: `hand-receipt-${args.receiptNumber}.pdf`, content: args.pdf }] : undefined;

  if (to) {
    const cc = to !== desk ? desk : undefined; // don't CC the same address we're sending to
    try {
      await sender.send({ to, cc, subject, text, attachments });
    } catch (e) {
      console.error(`[return-email] failed to email ${to}:`, e);
    }
  } else {
    console.info("[return-email] no recipient (customer email + G6_SERVICE_DESK_EMAIL both unset); skipping customer notification");
  }

  // Archive every return — UPDATED (partial) and CLOSED (full) — to the
  // admin/records inbox with the same subject/body the customer receives.
  const adminInbox = process.env.ADMIN_INBOX_EMAIL;
  if (adminInbox) {
    try {
      await sender.send({ to: adminInbox, subject, text, attachments });
    } catch (e) {
      console.error(`[return-email] failed to email admin inbox ${adminInbox}:`, e);
    }
  }
}
