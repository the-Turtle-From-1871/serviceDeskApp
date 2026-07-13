import type { User } from "@prisma/client";

// A deactivated account is hard-deleted this many months after it went inactive.
export const DEACTIVATION_PURGE_MONTHS = 3;

/** The newest `deactivatedAt` still old enough to purge: `now` minus 3 months.
 *  Accounts deactivated at or before this instant are age-eligible. */
export function deactivationCutoff(now: Date = new Date()): Date {
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - DEACTIVATION_PURGE_MONTHS);
  return cutoff;
}

/** Age + state eligibility only (NOT referential safety, which needs the DB).
 *  A null `deactivatedAt` — e.g. accounts deactivated before this field existed —
 *  is treated as not-yet-eligible, the safe default. Active accounts never qualify. */
export function isAccountPurgeEligible(
  user: Pick<User, "isActive" | "deactivatedAt">,
  now: Date = new Date(),
): boolean {
  if (user.isActive) return false;
  if (user.deactivatedAt === null) return false;
  return user.deactivatedAt.getTime() <= deactivationCutoff(now).getTime();
}

/** Referential safety: a user is only hard-deletable when nothing that would
 *  violate an ON DELETE RESTRICT foreign key still points at them. Item.createdById
 *  and ImportBatch.createdById are RESTRICT; Transfer / ReturnTransaction FKs are
 *  SET NULL and so do not block. Returns true when the delete WOULD break. */
export function hasBlockingReferences(counts: { items: number; importBatches: number }): boolean {
  return counts.items > 0 || counts.importBatches > 0;
}
