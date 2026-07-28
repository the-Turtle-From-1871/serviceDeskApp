import "server-only";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { listItemUics } from "@/modules/items/items.service";
import { auditCutoff, type AuditState } from "@/modules/audit/audit.status";
import type { ReadinessState } from "@/modules/items/readiness";
import {
  READINESS_CASE,
  READINESS_JOINS,
  itemScopeSql,
} from "@/modules/items/readiness.sql";

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
  type AuditReadinessSlice,
  type CategoryKpi,
  type GroupByKey,
  type ItemScope,
  type RangeKey,
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
    SELECT CASE
             WHEN i."lastAuditedAt" IS NULL          THEN 'never'
             WHEN i."lastAuditedAt" > ${cutoff}      THEN 'compliant'
             ELSE                                         'overdue'
           END AS state,
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

export async function getDashboard(scope: ItemScope, range: RangeKey, groupBy: GroupByKey) {
  const [units, auditReadiness, kpis, velocity, allocations, fleetTotal, vocabulary] =
    await Promise.all([
      listUnitOptions(),
      getAuditReadiness(scope),
      getFleetKpis(scope),
      getTransferVelocity(scope, range),
      getUnitAllocations(groupBy),
      prisma.item.count({ where: itemWhere(scope) }),
      // The full category vocabulary, in a stable order. Deliberately NOT
      // scoped by the UIC filter: it is the chart's COLOUR KEY, so it must be
      // identical whichever unit is selected, or series get repainted.
      prisma.deviceCategory
        .findMany({ select: { name: true }, orderBy: { name: "asc" }, take: 200 })
        .then((rows) => rows.map((r) => r.name)),
    ]);

  return { units, auditReadiness, kpis, velocity, allocations, fleetTotal, vocabulary };
}
