// Pure audit-status logic. An item's status is derived from its most recent audit
// date. Kept free of Prisma/React so it is unit-testable (mirrors
// service-queue.status.ts).

export type AuditState = "compliant" | "overdue" | "never";

export const AUDIT_PERIOD_YEARS = 1;

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
