import { getEmailSender, type EmailSender } from "@/lib/email";
import type { ReturnLineBalance } from "./plan";
import { formatDateTimeHST } from "@/lib/datetime";

export type ReturnEmailArgs = {
  receiver: { isDcsim: boolean; name: string; email: string | null };
  receiptNumber: string;
  receiptUrl: string;
  kind: "PARTIAL" | "FULL";
  returned: { serialNumber: string; make: string; model: string }[];
  byLine: ReturnLineBalance[];
  processedByName: string;
  processedByEmail: string;
  processedAt: Date;
};

function partialBody(a: ReturnEmailArgs): string {
  const items = a.returned.map((r) => `  - ${r.make} ${r.model} (SN ${r.serialNumber})`).join("\n");
  const balances = a.byLine
    .filter((l) => l.returnedNow > 0)
    .map((l) => `  - ${l.make} ${l.model}: Old: ${l.heldBefore} -> New Remaining: ${l.heldAfter}`)
    .join("\n");
  return [
    `A partial property return has been processed by the G6 service desk for hand receipt ${a.receiptNumber}.`,
    ``,
    `Items returned today (${a.returned.length}):`,
    items,
    ``,
    `New remaining balance still in your custody:`,
    balances,
    ``,
    `You remain financially liable for the remaining items under AR 735-5 until they are returned.`,
    ``,
    `View your hand receipt:`,
    a.receiptUrl,
    ``,
    `Processed by ${a.processedByName} (${a.processedByEmail}) on ${formatDateTimeHST(a.processedAt)}.`,
  ].join("\n");
}

function fullBody(a: ReturnEmailArgs): string {
  const items = a.returned.map((r) => `  - ${r.make} ${r.model} (SN ${r.serialNumber})`).join("\n");
  return [
    `All remaining equipment on hand receipt ${a.receiptNumber} has been returned and verified by the G6 service desk.`,
    ``,
    `**** STATUS: CLEARED / CLOSED ****`,
    ``,
    `Items turned in today (${a.returned.length}):`,
    items,
    ``,
    `Your active balance for this hand receipt is now zero. Your accountability is officially closed and you are no longer financially liable for tracking ID ${a.receiptNumber}.`,
    ``,
    `A closed-out copy of the form (marked CLOSED) is available here:`,
    a.receiptUrl,
    ``,
    `Save this email as your digital clearance record for out-processing, PCS, or ETS.`,
    ``,
    `Cleared by ${a.processedByName} (${a.processedByEmail}) on ${formatDateTimeHST(a.processedAt)}.`,
  ].join("\n");
}

// Notifies the customer of a return (CC the G6 desk). Best-effort: a send
// failure is logged and swallowed so it never rolls back the committed return.
export async function sendReturnEmail(args: ReturnEmailArgs, deps: { sender?: EmailSender } = {}): Promise<void> {
  const sender = deps.sender ?? getEmailSender();
  const desk = process.env.G6_SERVICE_DESK_EMAIL;
  const customer = !args.receiver.isDcsim && args.receiver.email ? args.receiver.email : undefined;

  const to = customer ?? desk;
  if (!to) {
    console.info("[return-email] no recipient (customer email + G6_SERVICE_DESK_EMAIL both unset); skipping notification");
    return; // nobody to notify
  }
  const cc = to !== desk ? desk : undefined; // don't CC the same address we're sending to

  const subject =
    args.kind === "FULL"
      ? `CLEARANCE RECORD: G6 Digital Hand Receipt - Final Property Return [ID: ${args.receiptNumber}]`
      : `UPDATE: G6 Digital Hand Receipt - Partial Property Return Confirmation [ID: ${args.receiptNumber}]`;

  const text = args.kind === "FULL" ? fullBody(args) : partialBody(args);

  try {
    await sender.send({ to, cc, subject, text });
  } catch (e) {
    console.error(`[return-email] failed to email ${to}:`, e);
  }
}
