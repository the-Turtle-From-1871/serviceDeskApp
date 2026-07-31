import "server-only";
import { Prisma } from "@prisma/client";
import { AUDIT_ORDER, auditCutoff } from "./audit.status";

/* ============================================================
   The SQL twin of auditState() in audit.status.ts.

   WHY A SECOND COPY EXISTS: auditState decides one row in TypeScript, which
   neither the analytics donut nor the /items sort can use — they bucket and
   order 1,200+ items and must do so in the database. Rather than let each
   surface restate "audited within one year", the rule is written once here and
   once there, and both derive their period from `auditCutoff` so the boundary
   can never drift even though the expression does.

   This mirrors readiness.sql.ts, for the same reason and with the same shape.
   ============================================================ */

/** Alias the caller must use for the Item table when embedding these. */
export const ITEM_ALIAS = "i";

/**
 * SQL expression yielding the same strings as AuditState.
 *
 * The cutoff is passed in rather than computed as `now() - interval '1 year'`
 * so the period comes from `AUDIT_PERIOD_YEARS` — one definition shared with
 * the per-row badge — and so a caller can pin `now` in a test instead of
 * racing the clock. It is a BOUND parameter, never interpolated (CLAUDE.md §2).
 *
 * Note the boundary matches `auditState`: strictly-greater-than the cutoff is
 * compliant, so the instant itself is overdue.
 */
export const auditCaseSql = (cutoff: Date) => Prisma.sql`
  CASE
    WHEN i."lastAuditedAt" IS NULL       THEN 'never'
    WHEN i."lastAuditedAt" > ${cutoff}   THEN 'compliant'
    ELSE                                      'overdue'
  END
`;

/**
 * auditCaseSql as an integer, so a query can ORDER BY the audit BADGE.
 *
 * WHY A RANK AND NOT `lastAuditedAt`: the /items Audit column displays a
 * three-value badge but used to sort by the timestamp behind it. Timestamps are
 * very nearly unique per row — production holds 31 audited rows with 31
 * distinct stamps — so a secondary sort key had no ties to break and did
 * nothing at all, which read as a broken control. Ranking the badge gives each
 * group real ties for the secondary key to order within.
 *
 * Sorting the CASE's own strings would order them alphabetically ('compliant',
 * 'never', 'overdue'), putting "never audited" between the two audited states.
 * The rank is built FROM `AUDIT_ORDER` so there is no second sequence here to
 * forget, and there is deliberately no ELSE: a state missing from AUDIT_ORDER
 * must be noticed as a NULL rank rather than quietly sorted to one end.
 *
 * State names and ranks are BOUND parameters, never interpolated.
 */
export const auditRankSql = (cutoff: Date) => Prisma.sql`(CASE ${auditCaseSql(cutoff)} ${Prisma.join(
  AUDIT_ORDER.map((state, rank) => Prisma.sql`WHEN ${state}::text THEN ${rank}::int`),
  " ",
)} END)`;

/** Convenience for callers that just want "the badge rule, as of now". */
export const auditRankNow = (now: Date = new Date()) => auditRankSql(auditCutoff(now));
