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
// Also maintains the denormalized Item.lastAuditedAt (the /items audit-status
// sort key): audits are only ever added, newest-wins, so the new row is always
// the latest. Done in one transaction so the column can't drift from the log.
export function recordAudit(input: RecordAuditInput): Promise<ItemAudit> {
  return prisma.$transaction(async (tx) => {
    const audit = await tx.itemAudit.create({ data: input });
    await tx.item.update({ where: { id: input.itemId }, data: { lastAuditedAt: audit.createdAt } });
    return audit;
  });
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

// (Removed getLatestAuditMap: the /items list now reads the denormalized
// Item.lastAuditedAt column directly for both the audit-status badge and the
// sort, so the separate per-page groupBy is no longer needed.)
