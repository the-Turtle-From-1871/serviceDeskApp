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

// One row of the detail-page audit history log. The signature IMAGE is
// deliberately absent — it's a large blob fetched on demand (getAuditSignature)
// so it isn't shipped to every viewer of the item page.
export type AuditLogRow = { id: string; signerName: string; createdAt: Date };

// All audits for an item, newest first, for the detail-page history log. Selects
// only the columns the log renders (no signature blob — see getAuditSignature).
export function getAuditsForItem(itemId: string): Promise<AuditLogRow[]> {
  return prisma.itemAudit.findMany({
    where: { itemId },
    orderBy: { createdAt: "desc" },
    select: { id: true, signerName: true, createdAt: true },
  });
}

// One audit's signature image, fetched on demand so the detail-page history log
// doesn't ship every signature blob to every viewer. Null if the audit is gone.
export async function getAuditSignature(auditId: string): Promise<string | null> {
  const row = await prisma.itemAudit.findUnique({
    where: { id: auditId },
    select: { signatureImage: true },
  });
  return row?.signatureImage ?? null;
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
