import "server-only";
import prisma from "@/lib/prisma";
import { dueState, DUE_SOON_DAYS, computeDueAt } from "@/modules/timers/due";
import { serviceTypeLabel } from "@/modules/service-queue/service-queue.status";

export type TransferTimerRow = { receiptNumber: string; itemSummary: string; dueAt: string };
export type ServiceTimerRow = { itemId: string; serialNumber: string; deviceName: string | null; serviceType: string; dueAt: string };

export async function getTimerDashboard(now: Date = new Date()) {
  const horizon = computeDueAt(now, DUE_SOON_DAYS); // overdue + due within the soon window
  const [transfers, service] = await Promise.all([
    prisma.transfer.findMany({
      where: { status: "OPEN", dueAt: { not: null, lte: horizon } },
      orderBy: { dueAt: "asc" },
      select: { receiptNumber: true, itemSummary: true, dueAt: true },
    }),
    prisma.serviceQueueItem.findMany({
      where: { status: "PENDING", dueAt: { not: null, lte: horizon } },
      orderBy: { dueAt: "asc" },
      select: { itemId: true, serviceType: true, serviceNote: true, dueAt: true, item: { select: { serialNumber: true, deviceName: true } } },
    }),
  ]);

  const overdueTransfers: TransferTimerRow[] = [];
  const soonTransfers: TransferTimerRow[] = [];
  for (const t of transfers) {
    const row = { receiptNumber: t.receiptNumber, itemSummary: t.itemSummary, dueAt: t.dueAt!.toISOString() };
    (dueState(t.dueAt, now).state === "overdue" ? overdueTransfers : soonTransfers).push(row);
  }

  const overdueService: ServiceTimerRow[] = [];
  const soonService: ServiceTimerRow[] = [];
  for (const s of service) {
    const row = { itemId: s.itemId, serialNumber: s.item.serialNumber, deviceName: s.item.deviceName, serviceType: serviceTypeLabel(s.serviceType, s.serviceNote), dueAt: s.dueAt!.toISOString() };
    (dueState(s.dueAt, now).state === "overdue" ? overdueService : soonService).push(row);
  }

  return { overdueTransfers, soonTransfers, overdueService, soonService };
}
