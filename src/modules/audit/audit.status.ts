// Pure audit-status logic. An item's status is derived from its most recent audit
// date. Kept free of Prisma/React so it is unit-testable (mirrors
// service-queue.status.ts).

export type AuditState = "compliant" | "overdue" | "never";

export const AUDIT_PERIOD_YEARS = 1;

/**
 * The badge sequence, best-verified to least, used to RANK an audit sort.
 *
 * WHY A RANK AND NOT THE TIMESTAMP: `/items` displays a three-value badge but
 * used to sort by `lastAuditedAt` itself. A timestamp is very nearly unique per
 * row — production carries 31 audited rows with 31 distinct stamps — so a
 * secondary sort key had no ties to break and silently did nothing. Ranking the
 * badge gives each group real ties, which is what makes "Audit, then Device
 * name" mean what the control implies.
 *
 * This is the SINGLE definition of that sequence. It was already the analytics
 * donut's render order, declared there as `AUDIT_STATE_ORDER`; that name is now
 * a re-export of this one (analytics.types.ts) rather than a second array,
 * because the palette's colourblind check was run against that exact order and
 * a sort that walked the states differently would contradict the chart. So:
 * `auditRankSql` builds the SQL CASE from this array, the donut stacks from it,
 * and `/items` sorts by it.
 *
 * `as const satisfies` keeps the literal tuple (the donut indexes it as a type)
 * while still checking every entry is a real AuditState.
 */
export const AUDIT_ORDER = ["compliant", "overdue", "never"] as const satisfies readonly AuditState[];

// null lastAuditedAt -> "never". Compliant while `now` is before the audit date
// plus one calendar year; "overdue" from that instant on (the boundary itself is
// overdue). setFullYear handles leap days by normalizing (Feb 29 -> Mar 1).
export function auditState(lastAuditedAt: Date | null, now: Date): AuditState {
  if (!lastAuditedAt) return "never";
  const expiry = new Date(lastAuditedAt);
  expiry.setFullYear(expiry.getFullYear() + AUDIT_PERIOD_YEARS);
  return now.getTime() < expiry.getTime() ? "compliant" : "overdue";
}

/**
 * The instant an item must have been audited AFTER to still count as compliant:
 * `now` minus the audit period.
 *
 * WHY: `auditState` above decides per row in JS, which the analytics donut cannot
 * do — it counts 1,100+ items in SQL. Rather than restate the rule in the query
 * (two definitions that would drift the moment AUDIT_PERIOD_YEARS changes), the
 * query buckets on `lastAuditedAt > cutoff`, which is the same comparison moved
 * to the other side. Both surfaces therefore share this one period definition.
 *
 * The two forms can disagree by a day for an audit dated Feb 29 (adding a year to
 * the audit vs subtracting one from `now` normalises the leap day in opposite
 * directions). Accepted: a one-day boundary difference on one calendar date is
 * not worth carrying a second, duplicated rule.
 */
export function auditCutoff(now: Date): Date {
  const cutoff = new Date(now);
  cutoff.setFullYear(cutoff.getFullYear() - AUDIT_PERIOD_YEARS);
  return cutoff;
}

export function auditStateDisplay(state: AuditState): { label: string; className: string } {
  switch (state) {
    case "compliant":
      return { label: "Compliant", className: "audit-dot--compliant" };
    case "overdue":
      return { label: "Overdue", className: "audit-dot--overdue" };
    case "never":
      return { label: "Never audited", className: "audit-dot--never" };
  }
}
