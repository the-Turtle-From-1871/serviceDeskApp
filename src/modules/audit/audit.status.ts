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
