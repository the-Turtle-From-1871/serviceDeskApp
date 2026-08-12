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

/* ------- Dormant-device export (30-90 days since the last MDM SYNC) ------- */

/**
 * The dormancy window, in days since `Item.lastSyncAt`.
 *
 * `lastSyncAt` is the parsed `lastSyncDateTime` — when MDM last CHECKED IN with
 * the device, NOT when a person last signed in (that is `lastLogonAt`). The two
 * answer different questions and routinely disagree; do not swap one for the
 * other here without changing every label that reads from these constants. This
 * list measured the SIGN-IN column until 2026-08-11 and was moved deliberately:
 * "we have not heard from this device" is the question the desk chases.
 *
 * BOTH ENDS ARE DELIBERATE. A device seen inside 30 days is not stale. A device
 * unseen for MORE than 90 days is excluded too — that is a different problem
 * (long-term lost kit) needing a different response, and folding it in here
 * would bury the devices still worth chasing under a backlog nobody clears.
 *
 * Held here rather than in the service so the button's label, the card's
 * wording and the SQL boundaries all read from one pair of numbers.
 */
export const STALE_MIN_DAYS = 30;
export const STALE_MAX_DAYS = 90;

/**
 * Hard cap on the exported row count, SHARED by both device exports.
 *
 * The fleet is ~1,200 items and this is a narrow slice of it, so the cap should
 * never bind — but "bound every list" has no exception for a list that happens
 * to be small today (CLAUDE.md). If it ever binds, the card SAYS so: silently
 * handing over a truncated property-book extract is a confident wrong answer
 * about which devices need chasing.
 */
export const DEVICE_EXPORT_MAX = 5000;

/**
 * Columns of the exported sheet, in order.
 *
 * ONE definition, read by the service that BUILDS the rows and by the workbook
 * builder that WRITES them — two lists would silently emit blank columns rather
 * than fail, since each side keys rows by header.
 *
 * The client no longer sees this list at all: since the export became a
 * server-built .xlsx (2026-08-11) the action hands back finished bytes, not
 * `{columns, rows}`. The wording here still described the CSV path.
 */
export const STALE_DEVICE_COLUMNS = [
  "Serial",
  "Device name",
  "Make",
  "Model",
  "Category",
  "Home unit",
  "UIC",
  "Holder",
  "Position",
  "Storage location",
  // WHO MDM last saw signed in — kept because it is who to ask about the
  // device. The two date columns beside it are the SYNC, which is what the
  // window measures; they are not the same fact and must not be relabelled
  // into each other.
  "Last logon user",
  "Last sync date",
  "Days since sync",
  // Added 2026-08-11 with the colour-coded export. It is not decoration: a
  // non-compliant row is RED regardless of age, so without this column the
  // sheet colours rows for a reason the reader cannot see.
  "Compliance",
  "Readiness",
] as const;

/** One row of the sheet, keyed by the header it sits under. */
export type StaleDeviceRow = Record<(typeof STALE_DEVICE_COLUMNS)[number], string | number>;

/* ------- Dropped-off-network export (no MDM sync time at all) ------- */

/**
 * The SIBLING list to the dormant one, and the distinction is the whole point.
 *
 * The dormant list asks "MDM saw this device, but not for 30-90 days". This one
 * asks "MDM cannot see this device AT ALL" — `Item.lastSyncAt IS NULL`. A device
 * with no sync instant can never appear on the dormant list at any age, because
 * there is no date to measure, so without this list it is invisible rather than
 * overdue.
 *
 * TWO THINGS PUT A DEVICE HERE: no sync time at all, or absence from the newest
 * FLEET CENSUS import — a device the Intune pull stopped listing. The second is
 * the stronger signal and the only one with a date attached, and it is what
 * makes the list self-maintaining: a device that reappears in a later export
 * leaves on its own.
 *
 * LOANER-POOL STOCK IS EXCLUDED, by explicit decision (2026-08-11): a loaner
 * sits on a shelf between loans and is not expected to be checking in, so its
 * absence is the normal state rather than something to chase. 7 of the 164
 * listed the day it landed.
 *
 * IT REQUIRES A DEVICE NAME, by explicit decision (2026-08-11). A row with no
 * name and no MDM record is a hand-created or scanned stub, not a machine that
 * fell off the network — on the live fleet that excluded 5 rows, including one
 * left over from testing.
 *
 * WHAT THE LIST HONESTLY CONTAINS, measured the day it was built: 164 devices,
 * of which only **12 had ever been in MDM and dropped out**; the other **152
 * have no MDM record of any kind** and most arrived in one pre-MDM inventory
 * load on 2026-07-16. Both are worth chasing and neither can be seen any other
 * way, but they are different problems — which is why `MDM record` below is a
 * column and not a footnote. Do not quietly widen or narrow this predicate
 * without re-reading that split; "dropped off the network" describes the 12.
 */
export const DROPPED_DEVICE_COLUMNS = [
  "Serial",
  "Device name",
  "Make",
  "Model",
  "Category",
  "Home unit",
  "UIC",
  "Holder",
  "Position",
  "Storage location",
  // The column that makes the sheet actionable: "Dropped out" is a device MDM
  // used to report and no longer does; "Never enrolled" never appeared in an
  // export at all. Derived from whether any MDM telemetry was ever stored.
  "MDM record",
  // The date the device dropped off: the first fleet census that did not list
  // it. Blank for a device that has not dropped off — one MDM never knew, or
  // one no census has run since. Derived, never stored (see
  // analytics.service.ts) so a device that reappears clears its own date.
  "Dropped off",
  "Last logon user",
  "Last logon date",
  "Compliance",
  "Readiness",
] as const;

export type DroppedDeviceRow = Record<(typeof DROPPED_DEVICE_COLUMNS)[number], string | number>;

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
