// Pure timer math shared by hand receipts, the service queue, and the UI. No
// Prisma/`server-only` here so it is unit-testable and safe in client bundles.
const DAY_MS = 24 * 60 * 60 * 1000;

export const DUE_SOON_DAYS = 3;

export type DueStateName = "none" | "ontrack" | "soon" | "overdue";
export type DueState = { state: DueStateName; days: number };

/** A deadline `days` whole days after `from`. Does not mutate `from`. */
export function computeDueAt(from: Date, days: number): Date {
  return new Date(from.getTime() + days * DAY_MS);
}

/** Classify a deadline relative to `now`. `days` is whole days until due
 *  (negative = overdue). Overdue includes the exact boundary (now >= dueAt),
 *  matching isPurgeEligible. */
export function dueState(dueAt: Date | null, now: Date = new Date()): DueState {
  if (!dueAt) return { state: "none", days: 0 };
  const diffMs = dueAt.getTime() - now.getTime();
  const days = Math.trunc(diffMs / DAY_MS);
  if (diffMs <= 0) return { state: "overdue", days };
  if (days <= DUE_SOON_DAYS) return { state: "soon", days };
  return { state: "ontrack", days };
}
