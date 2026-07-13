import "server-only"; // permanent-deletion worker — never bundle to the client
import prisma from "@/lib/prisma";

export type PurgeResult = { deletedCount: number };

// Permanently deletes every closed receipt whose 90-day purge window has elapsed.
// `purgeAfter` is only set when a receipt closes (see returns.service), so open
// receipts (purgeAfter = null) are inherently excluded. TransferLine / TransferItem
// / ReturnTransaction rows cascade on the Transfer FK, so the ledger goes with it.
export async function purgeExpiredTransfers(now: Date = new Date()): Promise<PurgeResult> {
  const res = await prisma.transfer.deleteMany({
    where: { purgeAfter: { not: null, lte: now } },
  });
  return { deletedCount: res.count };
}
