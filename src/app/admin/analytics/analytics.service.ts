import "server-only";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { listItemUics } from "@/modules/items/items.service";
import { auditCutoff, type AuditState } from "@/modules/audit/audit.status";
// The bucket CASE is shared with the /items audit sort so the donut and the
// table can never disagree about which badge a row carries.
import { auditCaseSql } from "@/modules/audit/audit.sql";
import { READINESS_LABEL, type ReadinessState } from "@/modules/items/readiness";
import {
  READINESS_CASE,
  READINESS_JOINS,
  itemScopeSql,
} from "@/modules/items/readiness.sql";
// THE definition of "in someone's custody right now" — imported, never restated.
// The stale-device export subtracts live custody from its result set, so it must
// mean exactly what the Readiness badge means by it.
import { CUSTODY_FROM, OPEN_CUSTODY_PREDICATE } from "@/modules/transfers/custody.sql";

/* ============================================================
   Analytics aggregation for the readiness dashboard.

   Every function here obeys the project's non-negotiable data-fetching
   rules (CLAUDE.md): aggregate in SQL, never query inside a loop, select
   only what is rendered, and bound every list. The page is a fixed handful
   of queries — it does not grow with the size of the fleet.

   Readiness is DERIVED, not stored (modules/items/readiness.ts). The two
   widgets that bucket by it embed READINESS_CASE / READINESS_JOINS so the
   database does the classifying; the parity test keeps that SQL and the
   TypeScript readinessState() answering identically.

   Every widget honours the same optional unit scope (`ItemScope`: a
   `deviceUIC` and/or a `homeUnit`), so the global Select at the top of the
   page and the unit-allocation table both re-scope the entire view.
   ============================================================ */

import {
  RANGES,
  UNCATEGORIZED,
  AUDIT_STATE_ORDER,
  STALE_MIN_DAYS,
  STALE_MAX_DAYS,
  STALE_EXPORT_MAX,
  type AuditReadinessSlice,
  type CategoryKpi,
  type GroupByKey,
  type ItemScope,
  type RangeKey,
  type StaleDeviceRow,
  type UnitAllocation,
  type VelocityPoint,
} from "./analytics.types";

// Re-exported so server callers have one import site. Client components must
// import from "./analytics.types" directly — this module is server-only.
export * from "./analytics.types";

/**
 * Base scope for every readiness aggregate.
 *
 * Lifecycle-RETIRED items are EXCLUDED. They are decommissioned kit, and would
 * otherwise pad the unit totals — and the audit-readiness donut — with equipment
 * nobody is responsible for finding, producing readiness figures that quietly
 * overstate. The rest of the app already treats retired as out of scope
 * (`/items` renders no audit state for them).
 *
 * NOTE the two different RETIREDs: `Item.status` is the ACTIVE/RETIRED
 * lifecycle filtered here; the derived readiness state "RETIRED" is what that
 * lifecycle looks like from the readiness side (see readiness.ts).
 *
 * THE ONE PLACE the global filter is expressed for Prisma queries — the raw
 * aggregates use its SQL twin, `itemScopeSql`. Both dimensions are optional and
 * compose with AND, so a `?unit=` picked from the allocation table and a `?uic=`
 * picked from the header Select narrow the page together instead of one
 * silently replacing the other. Exported so the scoping rule is directly
 * testable rather than only observable through a query.
 */
export const itemWhere = (scope: ItemScope): Prisma.ItemWhereInput => ({
  status: "ACTIVE",
  ...(scope.uic ? { deviceUIC: scope.uic } : {}),
  ...(scope.unit ? { homeUnit: scope.unit } : {}),
});

/* ------------------------------------------------------------
   Filter options — the distinct UICs present in the catalogue.
   ------------------------------------------------------------ */

/** Distinct deviceUIC values, for the global filter's option list.
 *
 *  Delegates to the shared `listItemUics` rather than keeping a near-identical
 *  copy of the same groupBy. The dashboard scopes to ACTIVE items (retired kit
 *  is out of scope for readiness — see itemWhere); /items lists everything, so
 *  it passes no status filter. */
export function listUnitOptions(limit = 200): Promise<string[]> {
  return listItemUics(limit, { status: "ACTIVE" });
}

/* ------------------------------------------------------------
   Widget 1 — Audit readiness (accounted for vs not).
   ------------------------------------------------------------ */

/**
 * Accountability by audit recency.
 *
 * This USED to read `Item.isAccountedFor`, a boolean defaulting to true that
 * only one admin bulk action ever wrote. In practice nothing wrote it, so the
 * donut reported a 100%-accounted-for fleet built entirely out of the column
 * default while the actual evidence of physical verification — an ItemAudit,
 * denormalized to `lastAuditedAt` — sat in a different column it never read.
 * The flag is gone; possession is now claimed only where an audit proves it.
 *
 * Bucketed in SQL rather than by fetching rows: this counts the whole fleet and
 * must stay one bounded query. `auditCutoff` keeps the period rule shared with
 * the per-row `auditState` badge instead of restating "1 year" here.
 */
export async function getAuditReadiness(scope: ItemScope): Promise<AuditReadinessSlice[]> {
  const cutoff = auditCutoff(new Date());
  // Parameterized $queryRaw — never string interpolation (CLAUDE.md §2).
  // Aliased `i` only so it can share the one scope fragment with the readiness
  // aggregates; this query derives no readiness of its own.
  const rows = await prisma.$queryRaw<{ state: AuditState; count: number }[]>(Prisma.sql`
    SELECT ${auditCaseSql(cutoff)} AS state,
           COUNT(*)::int AS count
    FROM "Item" i
    WHERE i."status" = 'ACTIVE'
      AND ${itemScopeSql(scope)}
    GROUP BY 1
  `);
  // Always emit all three slices so the legend is stable and the wedges sum to
  // the fleet size even when a state is empty.
  return AUDIT_STATE_ORDER.map((state) => ({
    state,
    count: Number(rows.find((r) => r.state === state)?.count ?? 0),
  }));
}

/* ------------------------------------------------------------
   Widget 2 — Fleet KPIs: In Service vs Ready, by category.
   ------------------------------------------------------------ */

type CategoryReadinessRow = { category: string | null; readiness: ReadinessState; count: number };

/**
 * In-service vs ready-to-deploy, per category.
 *
 * Readiness is DERIVED (readiness.ts), so this can no longer be a Prisma
 * `groupBy` over a stored column — the state comes from four signals across
 * three tables. It stays ONE bounded query all the same: READINESS_CASE
 * computes the state in SQL and the whole fleet is bucketed by the database,
 * never by fetching rows and classifying them here. The group count is at most
 * categories x 5 states regardless of fleet size.
 */
export async function getFleetKpis(scope: ItemScope): Promise<{
  totalDeployed: number;
  totalReady: number;
  byCategory: CategoryKpi[];
}> {
  // Parameterized Prisma.sql throughout — the only interpolations are the
  // pre-built fragments from readiness.sql.ts (CLAUDE.md §2).
  const rows = await prisma.$queryRaw<CategoryReadinessRow[]>(Prisma.sql`
    SELECT i."deviceCategory" AS category,
           ${READINESS_CASE} AS readiness,
           COUNT(*)::int AS count
    FROM "Item" i
    ${READINESS_JOINS}
    WHERE i."status" = 'ACTIVE'
      AND ${itemScopeSql(scope)}
    GROUP BY 1, 2
  `);

  const byCategory = new Map<string, CategoryKpi>();
  let totalDeployed = 0;
  let totalReady = 0;

  for (const r of rows) {
    // Only the two headline states are tiled; the rest are counted by the
    // query but deliberately not shown here (the card is "in service vs
    // ready", not a full readiness breakdown).
    if (r.readiness !== "DEPLOYED" && r.readiness !== "READY_TO_DEPLOY") continue;
    const category = r.category ?? UNCATEGORIZED;
    const entry = byCategory.get(category) ?? { category, deployed: 0, ready: 0 };
    const n = Number(r.count);
    if (r.readiness === "DEPLOYED") {
      entry.deployed += n;
      totalDeployed += n;
    } else {
      entry.ready += n;
      totalReady += n;
    }
    byCategory.set(category, entry);
  }

  return {
    totalDeployed,
    totalReady,
    byCategory: [...byCategory.values()].sort((a, b) => b.deployed + b.ready - (a.deployed + a.ready)),
  };
}

/* ------------------------------------------------------------
   Widget 3 — DA Form 2062 velocity.

   There is deliberately NO "fleet status over time" series any more.
   Readiness is derived from live signals (readiness.ts), so there is nothing
   to replay: the old chart read ItemStatusHistory snapshots of the stored
   `deployableStatus` enum, and both are gone. Reconstructing a timeline from
   today's signals would only ever redraw today's answer across the x-axis,
   which is a fabricated series, not history. If fleet readiness over time is
   wanted again it needs a deliberate periodic snapshot of the DERIVED state —
   a new feature, not a query.
   ------------------------------------------------------------ */

type VelocityRow = { month: Date; category: string | null; count: number };

/**
 * Items moved on completed (CLOSED) hand receipts, per month, by category.
 *
 * NOTE ON WHAT IS COUNTED: the unit is *items transferred*, not receipts. A
 * single receipt can carry a laptop and a switch, so it belongs to no one
 * category — counting receipts per category would double-count mixed receipts
 * and the stack would not sum to the total. Counting the items on them is
 * additive and stacks honestly. The UI labels the axis accordingly.
 *
 * CAVEAT: closed receipts are hard-deleted 90 days after closing by the purge
 * worker, so this series cannot see further back than that window regardless
 * of the range selected. Surfaced in the UI rather than hidden.
 */
export async function getTransferVelocity(
  scope: ItemScope,
  range: RangeKey,
): Promise<{ points: VelocityPoint[]; categories: string[] }> {
  const { days } = RANGES[range];
  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const rows = await prisma.$queryRaw<VelocityRow[]>(Prisma.sql`
    SELECT date_trunc('month', t."closedAt") AS month,
           i."deviceCategory" AS category,
           COUNT(*)::int AS count
    FROM "Transfer" t
    JOIN "TransferLine" tl ON tl."transferId" = t."id"
    JOIN "TransferItem" ti ON ti."transferLineId" = tl."id"
    JOIN "Item" i ON i."id" = ti."itemId"
    WHERE t."status" = 'CLOSED'
      AND t."closedAt" IS NOT NULL
      AND t."closedAt" >= ${start}::timestamptz
      AND i."status" = 'ACTIVE'
      AND ${itemScopeSql(scope)}
    GROUP BY 1, 2
    ORDER BY 1
  `);

  // Ordered by TOTAL VOLUME desc, not alphabetically: the chart folds the tail
  // into "Other" past the palette's 8 slots, and folding alphabetically would
  // bury the largest series while keeping trivial ones visible.
  const volume = new Map<string, number>();
  for (const r of rows) {
    const c = r.category ?? UNCATEGORIZED;
    volume.set(c, (volume.get(c) ?? 0) + Number(r.count));
  }
  const categories = [...volume.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([c]) => c);
  const byMonth = new Map<number, VelocityPoint>();
  for (const r of rows) {
    const t = r.month.getTime();
    let point = byMonth.get(t);
    if (!point) {
      point = { month: r.month.toISOString() };
      for (const c of categories) point[c] = 0;
      byMonth.set(t, point);
    }
    point[r.category ?? UNCATEGORIZED] = Number(r.count);
  }
  return {
    points: [...byMonth.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v),
    categories,
  };
}

/* ------------------------------------------------------------
   Widget 4 — Unit allocation leaderboard.
   ------------------------------------------------------------ */

type AllocationTotalRow = { value: string | null; total: number };
type AllocationReadinessRow = { value: string | null; readiness: ReadinessState; count: number };

/**
 * The two dimensions the leaderboard can group by, as SQL expressions over the
 * `i` alias.
 *
 * Picked from this frozen map BY KEY, so no part of the querystring ever
 * reaches the SQL text — an unknown `?groupBy` has already fallen back to the
 * default before this is indexed.
 *
 * `NULLIF(btrim(...), '')` folds a blank string into NULL so `""`, `"   "` and
 * a real NULL land in ONE Unassigned bucket rather than splitting into
 * indistinguishable look-alike rows.
 */
const GROUP_EXPR: Record<GroupByKey, Prisma.Sql> = {
  unit: Prisma.sql`NULLIF(btrim(i."homeUnit"), '')`,
  uic: Prisma.sql`NULLIF(btrim(i."deviceUIC"), '')`,
};

/**
 * Per-unit totals, grouped by whichever dimension the table is showing. TWO
 * grouped queries regardless of how many units exist — never one per unit.
 *
 * WHY THE DIMENSION IS A REAL `GROUP BY` AND NOT A RELABEL: `deviceUIC` and
 * `homeUnit` are not 1:1 in the catalogue (see GROUP_BY in analytics.types.ts),
 * so there is no name to display per UIC — the fleet genuinely partitions
 * differently under each, and both partitions are legitimate views.
 *
 * Why not one query grouping by (unit, readiness) with a `take`: a cap bounds
 * the number of GROUPS, and each unit produces up to one group per readiness
 * state. It would slice through the middle of a unit and report that unit's
 * totals as short — silently wrong numbers, which is worse than a visible
 * truncation. So: pick the top N units first (query 1), then derive the
 * readiness breakdown for exactly those units (query 2).
 *
 * Items with NO value in the chosen dimension are kept as the Unassigned
 * bucket instead of being filtered out. They are real inventory: drop them and
 * the Total column stops summing to the fleet count in the page header, which
 * reads as missing equipment rather than as unlabelled equipment.
 *
 * Deliberately NOT filtered by the global unit scope: the leaderboard is how a
 * user picks a unit, so it must keep listing every unit while one is selected.
 */
export async function getUnitAllocations(
  groupBy: GroupByKey,
  limit = 200,
): Promise<{ rows: UnitAllocation[]; truncated: boolean }> {
  const dimension = GROUP_EXPR[groupBy];

  // Raw rather than prisma.groupBy: only SQL can normalise blank-to-NULL before
  // grouping, and only an explicit ORDER BY can place the NULL bucket
  // deterministically. Fetch one extra row to detect truncation without a
  // second COUNT query.
  //
  // The cap is BOUND, not spliced, and the `::int` on it is not decoration:
  // LIMIT demands an integer, and a bare bind whose type the driver reports as
  // numeric/double is rejected outright by Postgres.
  const totals = await prisma.$queryRaw<AllocationTotalRow[]>(Prisma.sql`
    SELECT ${dimension} AS value,
           COUNT(*)::int AS total
    FROM "Item" i
    WHERE i."status" = 'ACTIVE'
    GROUP BY 1
    ORDER BY total DESC, value ASC NULLS LAST
    LIMIT ${limit + 1}::int
  `);

  const truncated = totals.length > limit;
  const page = totals.slice(0, limit);
  if (page.length === 0) return { rows: [], truncated: false };

  const values = page.map((t) => t.value).filter((v): v is string => v !== null);
  const hasUnassigned = page.some((t) => t.value === null);
  // Values are bound as parameters via Prisma.join, never spliced. `IN ()` is
  // not valid SQL, so the no-named-groups case (only the Unassigned bucket
  // survived the cap) degrades to FALSE instead of emitting a broken query.
  const named =
    values.length > 0 ? Prisma.sql`${dimension} IN (${Prisma.join(values)})` : Prisma.sql`FALSE`;
  const unassigned = hasUnassigned ? Prisma.sql` OR ${dimension} IS NULL` : Prisma.empty;

  // MUST carry the same status = 'ACTIVE' scope as the totals query above.
  // Without it the Deployed/Ready columns count lifecycle-retired kit that
  // Total excludes, so a unit with retired items could show Deployed + Ready
  // greater than its Total.
  const breakdown = await prisma.$queryRaw<AllocationReadinessRow[]>(Prisma.sql`
    SELECT ${dimension} AS value,
           ${READINESS_CASE} AS readiness,
           COUNT(*)::int AS count
    FROM "Item" i
    ${READINESS_JOINS}
    WHERE i."status" = 'ACTIVE'
      AND (${named}${unassigned})
    GROUP BY 1, 2
  `);

  // Keyed by the raw value — `null` is a perfectly good Map key, so the
  // Unassigned bucket needs no sentinel string that a real unit could collide
  // with. Insertion order is the SQL order, so the rows need no second sort.
  const byValue = new Map<string | null, UnitAllocation>(
    page.map((t) => [t.value, { value: t.value, total: Number(t.total), deployed: 0, ready: 0 }]),
  );
  for (const r of breakdown) {
    const entry = byValue.get(r.value);
    if (!entry) continue;
    if (r.readiness === "DEPLOYED") entry.deployed += Number(r.count);
    if (r.readiness === "READY_TO_DEPLOY") entry.ready += Number(r.count);
  }
  return { rows: [...byValue.values()], truncated };
}

/* ------------------------------------------------------------
   Page loader — every widget in one round of parallel queries.
   ------------------------------------------------------------ */

export type DashboardData = Awaited<ReturnType<typeof getDashboard>>;

/* ------------------------------------------------------------
   Dormant devices — the 30-90 day chase list.

   Answers "which devices has MDM NOT SEEN for a month, while there is still a
   realistic chance of finding them". Not a chart: it is an export, so the
   dashboard shows only the count and the sheet carries the rows.

   READ THE COLUMN CAREFULLY. `Item.lastSyncAt` is the parsed `lastSyncDateTime`
   — when MDM last CHECKED IN with the device. It is NOT when a person last
   signed in, which is `lastLogonDate`/`lastLogonAt` (see csv.ts, which says so
   at the alias). The two routinely disagree, which is why both exist: a device
   powered on in a cage syncs every night with no sign-in for months, and one
   somebody took home can show a recent sign-in and no sync at all.

   IT MEASURED THE OTHER COLUMN UNTIL 2026-08-11. The list shipped (2026-08-10)
   over `lastLogonAt` while describing itself as MDM silence; the wording was
   corrected first, and then — by request — the column was, because "we have not
   heard from this device" is the question the desk actually works from. Sign-in
   silence is the DIFFERENT query now: a device can be demonstrably online and
   simply unused, which is a utilisation question, not a chase list.

   The move needed the parsed twin (`lastSyncAt`, migration
   20260811150000_item_last_sync_at). It cannot be done over the raw text: a
   string comparison sorts '10/1/2025' ahead of '7/25/2026'.
   ------------------------------------------------------------ */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The window boundaries as instants.
 *
 * COMPUTED IN JS AND BOUND AS PARAMETERS — never `now()` inside the SQL. Two
 * reasons: `from` and `to` are then derived from ONE instant, so a query can
 * never straddle two different readings of the clock and return a window that
 * is not exactly 60 days wide; and an injected `now` is what makes the window
 * testable at all without freezing the database's clock.
 *
 * WHAT THIS DOES NOT GUARANTEE, because the wording here used to overclaim it:
 * the count on the card and the rows in the file are fetched by two SEPARATE
 * round trips — a page render and, later, a click — and each defaults its own
 * `now`. So a dashboard left open long enough for a device to cross the 30- or
 * 90-day line can export a set one row different from the number on screen.
 * That is accepted rather than engineered away: closing it means either passing
 * a client-supplied timestamp into the export (letting a caller choose the
 * window is a worse property than an off-by-one after an hour idle) or caching
 * the render's clock server-side per session, which is a lot of machinery for a
 * boundary crossing nobody has hit. Do not restore the stronger claim without
 * actually threading one instant through both calls.
 *
 * Half-open on purpose: `from` is inclusive, `to` exclusive, so exactly one of
 * the two boundaries can claim a device landing precisely on 30 days.
 */
export function staleSyncWindow(now: Date): { from: Date; to: Date } {
  return {
    // The OLDEST sync still in scope. Anything before this is past 90 days and
    // deliberately out of the sheet (see STALE_MAX_DAYS).
    from: new Date(now.getTime() - STALE_MAX_DAYS * DAY_MS),
    // The NEWEST sync still counted as stale.
    to: new Date(now.getTime() - STALE_MIN_DAYS * DAY_MS),
  };
}

/**
 * THE definition of "stale", as one SQL fragment.
 *
 * Shared by the count and the row query so the card can never say 47 and then
 * hand over 52 — the same reason readiness has one CASE rather than one per
 * surface. Each clause earns its place:
 *
 *  - `status = 'ACTIVE'`  retired kit has left the fleet; chasing it is noise,
 *                         and every other aggregate here scopes the same way.
 *  - `itemScopeSql`       the page's ?uic=/?unit= filter, through the same twin
 *                         the charts use, so the sheet covers exactly the slice
 *                         on screen.
 *  - `lastSyncAt NOT NULL`  a device MDM has never reported a sync for — or
 *                         whose export date would not parse — is not "last seen
 *                         45 days ago". It is "we cannot say", a different list.
 *                         EXPECT THIS TO EXCLUDE A LOT at first: the sync column
 *                         is newer than most rows, so a device only carries an
 *                         instant once an import has covered it.
 *  - the window           see staleSyncWindow.
 *  - `NOT EXISTS` custody a device issued out on a live hand receipt is
 *                         accounted for BY THAT RECEIPT. Silence from it is
 *                         expected there and is not evidence of anything.
 *
 * Every value is bound; the only interpolations are pre-built fragments
 * (CLAUDE.md §2).
 */
function staleDeviceWhere(scope: ItemScope, now: Date): Prisma.Sql {
  const { from, to } = staleSyncWindow(now);
  return Prisma.sql`
        i."status" = 'ACTIVE'
    AND ${itemScopeSql(scope)}
    AND i."lastSyncAt" IS NOT NULL
    AND i."lastSyncAt" >= ${from}::timestamptz
    AND i."lastSyncAt" <  ${to}::timestamptz
    AND NOT EXISTS (
      SELECT 1
      ${CUSTODY_FROM}
      WHERE ti."itemId" = i."id"
        AND ${OPEN_CUSTODY_PREDICATE}
    )
  `;
}

/**
 * How many devices are in the window. One aggregate, no rows fetched — this
 * runs on every dashboard load, so it must not pull the catalogue back to count
 * it. Needs no readiness join: nothing in the predicate reads one.
 */
export async function countStaleDevices(scope: ItemScope, now: Date = new Date()): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: number }[]>(Prisma.sql`
    SELECT COUNT(*)::int AS count
    FROM "Item" i
    WHERE ${staleDeviceWhere(scope, now)}
  `);
  return Number(rows[0]?.count ?? 0);
}

type StaleDeviceQueryRow = {
  serialNumber: string;
  deviceName: string | null;
  make: string;
  model: string;
  deviceCategory: string | null;
  homeUnit: string | null;
  deviceUIC: string | null;
  currentUserEmail: string | null;
  currentPosition: string | null;
  storageLocation: string | null;
  lastLogonUserPrincipalName: string | null;
  lastSyncAt: Date;
  compliance: string | null;
  readiness: ReadinessState;
};

/** `YYYY-MM-DD`, in UTC.
 *
 *  UTC and not local time because parseMdmDateTime builds the instant with
 *  `Date.UTC` from the MDM export's wall-clock date — reading it back in a
 *  westward local zone would shift the printed day one earlier than the export
 *  said. And an ISO date rather than the raw `7/25/2026 1:40:21 AM` text
 *  because a spreadsheet sorts and filters this one correctly; the raw string
 *  is a display artifact of the import, not a value.
 */
function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The rows behind the export.
 *
 * ONE query: the readiness column comes from READINESS_CASE in the database
 * rather than by classifying rows here, which would mean loading the service
 * queue and the receipt lines per item — the N+1 the data-fetching rules
 * forbid. Ordered stalest-first, because that is the order someone works the
 * list in, with `id` as the tie-break so the sheet is stable between runs.
 *
 * Bounded by STALE_EXPORT_MAX, taking one extra row purely as an overflow
 * probe so "is there more?" costs no second COUNT. The probe is trimmed before
 * it reaches the file.
 *
 * `currentUser` is the PHYSICAL column behind `currentUserEmail`
 * (`@map("currentUser")` in the schema) — raw SQL names physical columns.
 */
export async function listStaleDevices(
  scope: ItemScope,
  now: Date = new Date(),
): Promise<{ rows: StaleDeviceRow[]; truncated: boolean }> {
  const found = await prisma.$queryRaw<StaleDeviceQueryRow[]>(Prisma.sql`
    SELECT i."serialNumber",
           i."deviceName",
           i."make",
           i."model",
           i."deviceCategory",
           i."homeUnit",
           i."deviceUIC",
           i."currentUser" AS "currentUserEmail",
           i."currentPosition",
           i."storageLocation",
           i."lastLogonUserPrincipalName",
           i."lastSyncAt",
           i."compliance",
           ${READINESS_CASE} AS readiness
    FROM "Item" i
    ${READINESS_JOINS}
    WHERE ${staleDeviceWhere(scope, now)}
    ORDER BY i."lastSyncAt" ASC, i."id" ASC
    LIMIT ${STALE_EXPORT_MAX + 1}
  `);

  const truncated = found.length > STALE_EXPORT_MAX;
  const rows = (truncated ? found.slice(0, STALE_EXPORT_MAX) : found).map((r) => ({
    Serial: r.serialNumber,
    "Device name": r.deviceName ?? "",
    Make: r.make,
    Model: r.model,
    Category: r.deviceCategory ?? "",
    "Home unit": r.homeUnit ?? "",
    UIC: r.deviceUIC ?? "",
    // Free text, NOT a validated email — the importer copies the MDM export's
    // assigned-user column into it verbatim, so live rows hold values like
    // "SGT Smith" (CLAUDE.md §1). Exported as-is.
    Holder: r.currentUserEmail ?? "",
    Position: r.currentPosition ?? "",
    "Storage location": r.storageLocation ?? "",
    // Kept even though the window no longer reads it: the person MDM last saw
    // on the device is who to ask about it, which is exactly what a chase list
    // is for. It is who, not when — nothing here compares it to the window.
    "Last logon user": r.lastLogonUserPrincipalName ?? "",
    "Last sync date": isoDay(r.lastSyncAt),
    "Days since sync": Math.floor((now.getTime() - r.lastSyncAt.getTime()) / DAY_MS),
    // Verbatim from the MDM export ("compliant", "noncompliant",
    // "inGracePeriod"), NOT relabelled: the sheet is cross-checked against
    // Intune, and `staleSeverity` reads this same raw value to pick the row's
    // colour. Prettifying it here would leave the two describing one device
    // differently.
    Compliance: r.compliance ?? "",
    Readiness: READINESS_LABEL[r.readiness],
  }));

  return { rows, truncated };
}

export async function getDashboard(scope: ItemScope, range: RangeKey, groupBy: GroupByKey) {
  const [
    units,
    auditReadiness,
    kpis,
    velocity,
    allocations,
    fleetTotal,
    staleDeviceCount,
    vocabulary,
  ] =
    await Promise.all([
      listUnitOptions(),
      getAuditReadiness(scope),
      getFleetKpis(scope),
      getTransferVelocity(scope, range),
      getUnitAllocations(groupBy),
      prisma.item.count({ where: itemWhere(scope) }),
      // One aggregate, joining the same Promise.all — the stale-device card
      // costs the page a query, not a round trip.
      countStaleDevices(scope),
      // The full category vocabulary, in a stable order. Deliberately NOT
      // scoped by the UIC filter: it is the chart's COLOUR KEY, so it must be
      // identical whichever unit is selected, or series get repainted.
      prisma.deviceCategory
        .findMany({ select: { name: true }, orderBy: { name: "asc" }, take: 200 })
        .then((rows) => rows.map((r) => r.name)),
    ]);

  return {
    units,
    auditReadiness,
    kpis,
    velocity,
    allocations,
    fleetTotal,
    staleDeviceCount,
    vocabulary,
  };
}
