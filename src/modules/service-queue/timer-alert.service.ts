import "server-only";
import prisma from "@/lib/prisma";
import { getEmailSender, type EmailSender } from "@/lib/email";
import { dueState } from "@/modules/timers/due";
import { serviceTypeLabel } from "./service-queue.status";

export type AlertResult = { alertedCount: number };

// Emails the shared admin inbox once for each PENDING service item whose
// completion SLA has lapsed, then stamps overdueAlertedAt. Mirrors
// sendOverdueTransferAlerts (see that file for the retry/no-op rationale).
export async function sendOverdueServiceAlerts(
  now: Date = new Date(),
  deps: { sender?: EmailSender } = {},
): Promise<AlertResult> {
  const adminInbox = process.env.ADMIN_INBOX_EMAIL;
  if (!adminInbox) return { alertedCount: 0 };

  const overdue = await prisma.serviceQueueItem.findMany({
    where: { status: "PENDING", dueAt: { not: null, lte: now }, overdueAlertedAt: null },
    select: {
      id: true, serviceType: true, serviceNote: true, dueAt: true,
      item: { select: { serialNumber: true, deviceName: true, homeUnit: true } },
    },
  });
  if (overdue.length === 0) return { alertedCount: 0 };

  const sender = deps.sender ?? getEmailSender();
  let alertedCount = 0;
  for (const s of overdue) {
    const daysOverdue = Math.abs(dueState(s.dueAt, now).days);
    const label = serviceTypeLabel(s.serviceType, s.serviceNote);
    const subject = `OVERDUE service: SN ${s.item.serialNumber}`;
    const text = [
      `A service item is past its completion deadline (${daysOverdue} day(s) overdue).`,
      ``,
      `SN: ${s.item.serialNumber}`,
      `Device: ${s.item.deviceName ?? "—"}`,
      `Unit: ${s.item.homeUnit ?? "—"}`,
      `Service: ${label}`,
      ``,
      `Complete this service or mark it done in the queue.`,
    ].join("\n");
    try {
      await sender.send({ to: adminInbox, subject, text });
      await prisma.serviceQueueItem.update({ where: { id: s.id }, data: { overdueAlertedAt: now } });
      alertedCount++;
    } catch (e) {
      console.error(`[service-timer-alert] failed to alert SN ${s.item.serialNumber}:`, e);
    }
  }
  return { alertedCount };
}
