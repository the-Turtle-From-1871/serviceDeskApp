import type { ItemAudit } from "@prisma/client";
import prisma from "@/lib/prisma";
import { putSignatureAsset } from "@/modules/signatures/signature-asset.service";
import { MAX_BULK_ITEMS } from "@/modules/items/items.schema";
import { ItemError } from "@/modules/items/items.errors";

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
//
// The caller still hands over the raw image: deduplication into SignatureAsset is
// this service's business, not the action's, so `markAuditedAction` is unchanged.
// The asset is written inside the SAME transaction as the audit row — the FK on
// ItemAudit.signatureSha has to see it, and a rolled-back audit must not leave a
// stray asset.
export function recordAudit(input: RecordAuditInput): Promise<ItemAudit> {
  return prisma.$transaction(async (tx) => {
    const { signatureImage, ...rest } = input;
    const signatureSha = await putSignatureAsset(tx, signatureImage);
    const audit = await tx.itemAudit.create({ data: { ...rest, signatureSha } });
    await tx.item.update({ where: { id: input.itemId }, data: { lastAuditedAt: audit.createdAt } });
    return audit;
  });
}

export type RecordAuditsInput = {
  itemIds: string[];
  auditedById: string;
  auditedByName: string;
  signerName: string;
  signatureImage: string;
};

/**
 * Record ONE audit event per item, under a single signature — the batched twin
 * of recordAudit, for a shelf sweep.
 *
 * Four queries in one transaction, never one per item. Step 2 is the whole
 * reason this is affordable: the signature is content-addressed, so 150 audits
 * reference ONE SignatureAsset row rather than storing 150 copies of the blob.
 *
 * RETIRED items are excluded and REPORTED, not refused. That deliberately
 * diverges from markAuditedAction, which rejects a retired item outright: right
 * for one item, wrong for a batch, where one retired device must not fail an
 * audit of 150.
 *
 * `now` is computed here and BOUND to both the audit rows and lastAuditedAt.
 * ItemAudit.createdAt is @default(now()), so omitting it would take the
 * database's clock per row and leave the denormalized column milliseconds adrift
 * from the log it summarizes — the drift the single transaction exists to
 * prevent.
 *
 * Enforces NO permissions — the calling Server Action owns the admin guard.
 */
export async function recordAudits(
  input: RecordAuditsInput,
): Promise<{ updated: number; skipped: number }> {
  const ids = [...new Set(input.itemIds.filter((id) => id.trim() !== ""))];
  if (ids.length === 0) return { updated: 0, skipped: 0 };
  if (ids.length > MAX_BULK_ITEMS) throw new ItemError("TOO_MANY");

  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const active = await tx.item.findMany({
      where: { id: { in: ids }, status: "ACTIVE" },
      select: { id: true },
    });
    if (active.length === 0) return { updated: 0, skipped: ids.length };

    const signatureSha = await putSignatureAsset(tx, input.signatureImage);
    const activeIds = active.map((a) => a.id);

    await tx.itemAudit.createMany({
      data: activeIds.map((itemId) => ({
        itemId,
        auditedById: input.auditedById,
        auditedByName: input.auditedByName,
        signerName: input.signerName,
        signatureSha,
        createdAt: now,
      })),
    });
    await tx.item.updateMany({
      where: { id: { in: activeIds } },
      data: { lastAuditedAt: now },
    });

    return { updated: activeIds.length, skipped: ids.length - activeIds.length };
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
// The blob lives in SignatureAsset (deduplicated); this rehydrates it, so callers
// still get a data URL and nothing downstream changed.
export async function getAuditSignature(auditId: string): Promise<string | null> {
  const row = await prisma.itemAudit.findUnique({
    where: { id: auditId },
    select: { signatureAsset: { select: { image: true } } },
  });
  return row?.signatureAsset.image ?? null;
}

// (Removed getLatestAuditMap: the /items list now reads the denormalized
// Item.lastAuditedAt column directly for both the audit-status badge and the
// sort, so the separate per-page groupBy is no longer needed.)
