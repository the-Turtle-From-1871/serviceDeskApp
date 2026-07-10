import { getEmailSender, type EmailSender } from "@/lib/email";

export const PICKUP_SUBJECT = "DCSIM Service Desk - Items Ready for Pickup";

export type PickupItem = { make: string; model: string; serialNumber: string };

export type PickupEmailArgs = {
  customerName: string;
  customerEmail: string;
  receiptNumber: string;
  receiptUrl: string;
  items: PickupItem[];
};

// Minimal receipt shape needed to resolve the customer + the items awaiting
// pickup. Structurally compatible with the loaded ReceiptWithLines.
type PickupReceipt = {
  senderIsDcsim: boolean;
  senderName: string;
  senderEmail: string | null;
  receiverIsDcsim: boolean;
  receiverName: string;
  receiverEmail: string | null;
  lines: { make: string; model: string; items: { serialNumber: string; returnedAt: Date | null }[] }[];
};

/** The customer is the non-DCSIM party. Both parties are never DCSIM (enforced
 *  at creation); if both are non-DCSIM, the receiver is the one picking up. */
export function customerParty(t: PickupReceipt): { name: string; email: string | null } | null {
  if (!t.receiverIsDcsim) return { name: t.receiverName, email: t.receiverEmail };
  if (!t.senderIsDcsim) return { name: t.senderName, email: t.senderEmail };
  return null;
}

/** Items still awaiting pickup: every serial not yet returned, flattened. */
export function pickupItems(t: PickupReceipt): PickupItem[] {
  return t.lines.flatMap((ln) =>
    ln.items
      .filter((it) => it.returnedAt === null)
      .map((it) => ({ make: ln.make, model: ln.model, serialNumber: it.serialNumber })),
  );
}

function body(a: PickupEmailArgs): string {
  const list = a.items.map((i) => `  - ${i.make} ${i.model} (SN ${i.serialNumber})`).join("\n");
  return [
    `Your equipment is ready for pickup at the DCSIM Service Desk.`,
    ``,
    `Items ready (${a.items.length}):`,
    list,
    ``,
    `Please coordinate with the DCSIM Service Desk to collect your equipment.`,
    ``,
    `Reference hand receipt ${a.receiptNumber}:`,
    a.receiptUrl,
  ].join("\n");
}

// Notifies the customer that the items on their hand receipt are ready for
// pickup. Unlike the automatic receipt/return emails, errors are NOT swallowed:
// this is a staff-initiated action, so the caller reports success/failure.
export async function sendPickupEmail(args: PickupEmailArgs, deps: { sender?: EmailSender } = {}): Promise<void> {
  const sender = deps.sender ?? getEmailSender();
  await sender.send({ to: args.customerEmail, subject: PICKUP_SUBJECT, text: body(args) });
}
