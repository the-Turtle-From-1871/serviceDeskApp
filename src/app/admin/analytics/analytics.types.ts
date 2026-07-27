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

/** `null` = "All Units". A UIC of `""` is normalised to null by the caller. */
export type UicFilter = string | null;

/* ---------- Row shapes returned by the service ---------- */

/** One slice of the audit-readiness donut. Accountability is DERIVED from audit
 *  recency — there is no stored "accounted for" flag (see docs/ARCHITECTURE.md).
 *  All three states are always emitted, so the legend is stable and the slices
 *  sum to the fleet size. */
export type AuditReadinessSlice = { state: AuditState; count: number };

/** Render/stack order, worst-last. Also the order the palette's adjacent-pair
 *  CVD check was run against — keep them in step. */
export const AUDIT_STATE_ORDER = ["compliant", "overdue", "never"] as const;
export type CategoryKpi = { category: string; deployed: number; ready: number };
export type VelocityPoint = { month: string } & Record<string, string | number>;
export type UnitAllocation = { uic: string; total: number; deployed: number; ready: number };
