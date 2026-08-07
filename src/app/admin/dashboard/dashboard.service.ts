import "server-only";
import type { TransferStatus } from "@prisma/client";
import prisma from "@/lib/prisma";
import { dueState, DUE_SOON_DAYS, computeDueAt } from "@/modules/timers/due";
import { serviceTypeLabel } from "@/modules/service-queue/service-queue.status";

export type TransferTimerRow = { receiptNumber: string; itemSummary: string; dueAt: string };
export type ServiceTimerRow = { itemId: string; serialNumber: string; deviceName: string | null; serviceType: string; dueAt: string };
export type RecentReceiptRow = {
  receiptNumber: string;
  itemSummary: string;
  receiverName: string;
  status: TransferStatus;
  createdAt: string;
};

/** How many receipts the dashboard card shows. */
export const RECENT_RECEIPT_COUNT = 10;

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

  return { overdueTransfers, soonTransfers, overdueService, soonService, nowMs: now.getTime() };
}

/** The newest hand receipts, regardless of status, for the dashboard card.
 *
 *  The explicit `select` is load-bearing, not cosmetic: `Transfer.receiverSignature`
 *  is a base64 PNG stored on the row, so a bare `findMany` would pull `limit`
 *  signature images into every dashboard render. Only the columns the card shows
 *  are read — the same reason `searchReceiptsByNumber` selects two fields.
 *
 *  Bounded by `take`, and the `createdAt desc` order is served by the existing
 *  `@@index([createdAt])`.
 *
 *  Reachable window: closed receipts are purged 90 days after closing, so this
 *  list can never reach further back than that for a closed one.
 */
export async function getRecentReceipts(limit: number = RECENT_RECEIPT_COUNT): Promise<RecentReceiptRow[]> {
  const rows = await prisma.transfer.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { receiptNumber: true, itemSummary: true, receiverName: true, status: true, createdAt: true },
  });
  return rows.map((t) => ({
    receiptNumber: t.receiptNumber,
    itemSummary: t.itemSummary,
    receiverName: t.receiverName,
    status: t.status,
    createdAt: t.createdAt.toISOString(),
  }));
}
