import "server-only"; // sends mail + reads PII — never bundle to the client
import prisma from "@/lib/prisma";
import { getEmailSender, type EmailSender } from "@/lib/email";
import { dueState } from "@/modules/timers/due";

export type AlertResult = { alertedCount: number };

// Emails the shared admin inbox once for each OPEN hand receipt whose return
// timer has lapsed and that has not been alerted yet, then stamps
// overdueAlertedAt so it never re-alerts. A send failure leaves the stamp unset
// so the next daily run retries. No-op (nothing stamped) when the admin inbox
// is unconfigured, so an alert is never silently dropped.
export async function sendOverdueTransferAlerts(
  now: Date = new Date(),
  deps: { sender?: EmailSender } = {},
): Promise<AlertResult> {
  const adminInbox = process.env.ADMIN_INBOX_EMAIL;
  if (!adminInbox) return { alertedCount: 0 };

  const overdue = await prisma.transfer.findMany({
    where: { status: "OPEN", dueAt: { not: null, lte: now }, overdueAlertedAt: null },
    select: { id: true, receiptNumber: true, itemSummary: true, dueAt: true },
  });
  if (overdue.length === 0) return { alertedCount: 0 };

  const sender = deps.sender ?? getEmailSender();
  let alertedCount = 0;
  for (const t of overdue) {
    const daysOverdue = Math.abs(dueState(t.dueAt, now).days);
    const subject = `OVERDUE: hand receipt ${t.receiptNumber}`;
    const text = [
      `Hand receipt ${t.receiptNumber} is past its return deadline (${daysOverdue} day(s) overdue).`,
      ``,
      `Items: ${t.itemSummary}`,
      ``,
      `Recover these devices promptly, then process the return to close the receipt.`,
    ].join("\n");
    try {
      await sender.send({ to: adminInbox, subject, text });
      await prisma.transfer.update({ where: { id: t.id }, data: { overdueAlertedAt: now } });
      alertedCount++;
    } catch (e) {
      console.error(`[transfer-timer-alert] failed to alert ${t.receiptNumber}:`, e);
    }
  }
  return { alertedCount };
}
