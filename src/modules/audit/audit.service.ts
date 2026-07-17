import type { ItemAudit } from "@prisma/client";
import prisma from "@/lib/prisma";

export type RecordAuditInput = {
  itemId: string;
  auditedById: string;
  auditedByName: string;
  signerName: string;
  signatureImage: string;
};

// Record one audit event. The item's status is derived from the newest row.
export function recordAudit(input: RecordAuditInput): Promise<ItemAudit> {
  return prisma.itemAudit.create({ data: input });
}

// All audits for an item, newest first, for the detail-page history log.
export function getAuditsForItem(itemId: string): Promise<ItemAudit[]> {
  return prisma.itemAudit.findMany({
    where: { itemId },
    orderBy: { createdAt: "desc" },
  });
}

// Newest audit date per item, for the list view. One grouped query; skips items
// with no audit (they stay absent from the map and render as "never").
export async function getLatestAuditMap(itemIds: string[]): Promise<Map<string, Date>> {
  if (itemIds.length === 0) return new Map();
  const rows = await prisma.itemAudit.groupBy({
    by: ["itemId"],
    where: { itemId: { in: itemIds } },
    _max: { createdAt: true },
  });
  const map = new Map<string, Date>();
  for (const r of rows) if (r._max.createdAt) map.set(r.itemId, r._max.createdAt);
  return map;
}
