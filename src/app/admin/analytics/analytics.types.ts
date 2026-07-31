/* ============================================================
   Shared analytics vocabulary — constants, labels, and row shapes.

   Deliberately FREE of `server-only` and of any Prisma runtime import, so
   the client widgets can import these values (labels, range definitions)
   without dragging the query layer — and the database client — into the
   browser bundle. analytics.service.ts re-exports everything here, so
   server code has a single import site.
   ============================================================ */

// Pure derivation logic (no Prisma runtime) — safe for the client bundle.
import type { AuditState } from "@/modules/audit/audit.status";

/** Readiness has ONE definition, next to the function that derives it
 *  (modules/items/readiness.ts). Re-exported rather than restated so the
 *  dashboard and the /items table cannot drift apart — there is no second
 *  state list or label map to keep in step. */
export type { ReadinessState } from "@/modules/items/readiness";

/** Time windows offered by the range ToggleGroup, in days. Used by the
 *  transfer-velocity series, which buckets by calendar month in SQL — so a
 *  window only ever yields a handful of points regardless of its length. */
export const RANGES = {
  "30d": { days: 30, label: "30 days" },
  "90d": { days: 90, label: "90 days" },
  "6m": { days: 182, label: "6 months" },
  "1y": { days: 365, label: "1 year" },
} as const;

export type RangeKey = keyof typeof RANGES;
export const isRangeKey = (v: string): v is RangeKey => v in RANGES;

/** Category is free text and nullable; uncategorised items group under this
 *  label so they stay visible instead of vanishing from the breakdown. */
export const UNCATEGORIZED = "Uncategorized";

/** Shown for the leaderboard bucket holding items with no value in the chosen
 *  grouping dimension. That bucket is REAL inventory, so it is displayed rather
 *  than filtered away — drop it and the table's Total column stops reconciling
 *  with the fleet count in the page header. */
export const UNASSIGNED = "Unassigned";

/**
 * The global scope every widget on the dashboard is queried under.
 *
 * TWO independent filters, not one, because the unit-allocation table can group
 * by either dimension and each needs its own URL param. They compose with AND
 * when both are set (`?unit=Alpha%20Co&uic=WABCAA`), which is the honest reading
 * of "both filters are on" — and it means switching the table's grouping never
 * has to silently discard the filter the top-of-page Select applied.
 *
 * `null` = unfiltered. A param of `""` is normalised to null by the page.
 */
export type ItemScope = { uic: string | null; unit: string | null };

/** Human description of the active scope. ONE implementation, used by the page
 *  header and by every export filename, so a downloaded CSV always says which
 *  slice of the fleet it came from. */
export function scopeLabel(scope: ItemScope): string {
  const parts: string[] = [];
  if (scope.unit) parts.push(`unit ${scope.unit}`);
  if (scope.uic) parts.push(`UIC ${scope.uic}`);
  return parts.length > 0 ? parts.join(" · ") : "all units";
}

/**
 * How the unit-allocation table buckets the fleet.
 *
 * This switches the GROUPING DIMENSION, it does not relabel rows. `deviceUIC`
 * and `homeUnit` are NOT 1:1 in the catalogue: of 44 distinct UICs only 18 have
 * a single home-unit name, 20 map to several (one spans 46 names), and 6 have
 * none at all. The `Unit` table (abbreviation → fullName) cannot bridge them
 * either — none of the item UICs match any of its abbreviations. So there is no
 * "representative name" to display per UIC; picking one would be wrong for 20
 * of the 44. Each dimension gets its own `GROUP BY` and its own filter param.
 */
export const GROUP_BY = {
  unit: { label: "Unit name", column: "Unit", noun: "unit name", param: "unit" },
  uic: { label: "UIC", column: "Unit (UIC)", noun: "UIC", param: "uic" },
} as const;

export type GroupByKey = keyof typeof GROUP_BY;
export const isGroupByKey = (v: string): v is GroupByKey => v in GROUP_BY;
/** Unit name, not UIC: it is the label an operator recognises. */
export const DEFAULT_GROUP_BY: GroupByKey = "unit";

/* ---------- Row shapes returned by the service ---------- */

/** One slice of the audit-readiness donut. Accountability is DERIVED from audit
 *  recency — there is no stored "accounted for" flag (see docs/ARCHITECTURE.md).
 *  All three states are always emitted, so the legend is stable and the slices
 *  sum to the fleet size. */
export type AuditReadinessSlice = { state: AuditState; count: number };

/** Render/stack order, worst-last. Also the order the palette's adjacent-pair
 *  CVD check was run against — keep them in step.
 *
 *  RE-EXPORTED, not redeclared: the `/items` audit sort ranks its badges by this
 *  same sequence (see AUDIT_ORDER), and two copies would let the table walk the
 *  states in an order the donut contradicts. The name is kept because the
 *  palette and the widgets read it. */
export { AUDIT_ORDER as AUDIT_STATE_ORDER } from "@/modules/audit/audit.status";
export type CategoryKpi = { category: string; deployed: number; ready: number };
export type VelocityPoint = { month: string } & Record<string, string | number>;

/** One row of the unit-allocation leaderboard.
 *
 *  `value` is the raw grouping value AND the filter param the row sets when
 *  clicked. `null` is the Unassigned bucket: it is displayed (see UNASSIGNED)
 *  but is not selectable, because "no unit" is the absence of a filter value,
 *  not one the URL could carry. */
export type UnitAllocation = {
  value: string | null;
  total: number;
  deployed: number;
  ready: number;
};
