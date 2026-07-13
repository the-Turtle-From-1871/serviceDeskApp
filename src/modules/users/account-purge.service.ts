import "server-only"; // permanent account-deletion worker — never bundle to the client
import prisma from "@/lib/prisma";
import { deactivationCutoff, hasBlockingReferences } from "./account-purge";

export type AccountPurgeResult = {
  deletedCount: number;
  deletedIds: string[];
  skipped: { id: string; reason: string }[];
};

// Hard-deletes accounts that have been inactive for 3+ months, but only when the
// removal is referentially safe. Item.createdById / ImportBatch.createdById are
// ON DELETE RESTRICT, so a user who created items or import batches cannot be
// deleted without destroying that history — those users are SKIPPED and logged,
// never force-cascaded. Transfer / ReturnTransaction FKs are ON DELETE SET NULL
// and detach automatically. Each delete is also wrapped so an unexpected FK error
// on one user skips that user rather than aborting the whole sweep.
export async function purgeDeactivatedUsers(now: Date = new Date()): Promise<AccountPurgeResult> {
  const cutoff = deactivationCutoff(now);
  const candidates = await prisma.user.findMany({
    where: { isActive: false, deactivatedAt: { not: null, lte: cutoff } },
    select: { id: true, email: true },
  });

  const deletedIds: string[] = [];
  const skipped: { id: string; reason: string }[] = [];

  for (const user of candidates) {
    const [items, importBatches] = await Promise.all([
      prisma.item.count({ where: { createdById: user.id } }),
      prisma.importBatch.count({ where: { createdById: user.id } }),
    ]);

    if (hasBlockingReferences({ items, importBatches })) {
      const reason = `has referential dependencies (items: ${items}, importBatches: ${importBatches})`;
      skipped.push({ id: user.id, reason });
      console.warn(`[purgeDeactivatedUsers] skipped ${user.email} — ${reason}`);
      continue;
    }

    try {
      await prisma.user.delete({ where: { id: user.id } });
      deletedIds.push(user.id);
    } catch (e) {
      const reason = "delete failed (unexpected referential constraint)";
      skipped.push({ id: user.id, reason });
      console.error(`[purgeDeactivatedUsers] ${reason} for ${user.email}:`, e);
    }
  }

  return { deletedCount: deletedIds.length, deletedIds, skipped };
}
