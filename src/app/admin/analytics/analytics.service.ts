import "server-only";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { listItemUics } from "@/modules/items/items.service";
import { auditCutoff, type AuditState } from "@/modules/audit/audit.status";
import type { ReadinessState } from "@/modules/items/readiness";
import {
  READINESS_CASE,
  READINESS_JOINS,
  readinessScope,
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

   Every widget honours the same optional `deviceUIC` filter, so the
   global Select at the top of the page re-scopes the entire view.
   ============================================================ */

import {
  RANGES,
  UNCATEGORIZED,
  AUDIT_STATE_ORDER,
  type AuditReadinessSlice,
  type CategoryKpi,
  type RangeKey,
  type UicFilter,
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
 */
const itemWhere = (uic: UicFilter): Prisma.ItemWhereInput => ({
  status: "ACTIVE",
  ...(uic ? { deviceUIC: uic } : {}),
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
export async function getAuditReadiness(uic: UicFilter): Promise<AuditReadinessSlice[]> {
  const cutoff = auditCutoff(new Date());
  // Parameterized $queryRaw — never string interpolation (CLAUDE.md §2).
  const rows = await prisma.$queryRaw<{ state: AuditState; count: number }[]>(Prisma.sql`
    SELECT CASE
             WHEN "lastAuditedAt" IS NULL          THEN 'never'
             WHEN "lastAuditedAt" > ${cutoff}      THEN 'compliant'
             ELSE                                       'overdue'
           END AS state,
           COUNT(*)::int AS count
    FROM "Item"
    WHERE "status" = 'ACTIVE'
      AND (${uic}::text IS NULL OR "deviceUIC" = ${uic}::text)
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
export async function getFleetKpis(uic: UicFilter): Promise<{
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
      AND ${readinessScope(uic)}
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
  uic: UicFilter,
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
      AND (${uic}::text IS NULL OR i."deviceUIC" = ${uic}::text)
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

type UnitReadinessRow = { uic: string; readiness: ReadinessState; count: number };

/**
 * Per-UIC totals. TWO grouped queries regardless of how many units exist —
 * never one per unit.
 *
 * Why not one query grouping by (unit, readiness) with a `take`: a cap bounds
 * the number of GROUPS, and each unit produces up to one group per readiness
 * state. It would slice through the middle of a unit and report that unit's
 * totals as short — silently wrong numbers, which is worse than a visible
 * truncation. So: pick the top N units first (query 1), then derive the
 * readiness breakdown for exactly those units (query 2).
 *
 * Deliberately NOT filtered by the global UIC filter: the leaderboard is how
 * a user picks a unit, so it must keep listing every unit while one is
 * selected.
 */
export async function getUnitAllocations(limit = 200): Promise<{
  rows: UnitAllocation[];
  truncated: boolean;
}> {
  const totals = await prisma.item.groupBy({
    by: ["deviceUIC"],
    where: { status: "ACTIVE", deviceUIC: { not: null } },
    _count: { _all: true },
    orderBy: { _count: { deviceUIC: "desc" } },
    // Fetch one extra to detect truncation without a second COUNT query.
    take: limit + 1,
  });

  const truncated = totals.length > limit;
  const page = totals.slice(0, limit);
  const uics = page.map((t) => t.deviceUIC).filter((u): u is string => u !== null);
  if (uics.length === 0) return { rows: [], truncated: false };

  // MUST carry the same status = 'ACTIVE' scope as the totals query above.
  // Without it the Deployed/Ready columns count lifecycle-retired kit that
  // Total excludes, so a unit with retired items could show Deployed + Ready
  // greater than its Total. The UIC list is bound as parameters, never spliced.
  const breakdown = await prisma.$queryRaw<UnitReadinessRow[]>(Prisma.sql`
    SELECT i."deviceUIC" AS uic,
           ${READINESS_CASE} AS readiness,
           COUNT(*)::int AS count
    FROM "Item" i
    ${READINESS_JOINS}
    WHERE i."status" = 'ACTIVE'
      AND i."deviceUIC" IN (${Prisma.join(uics)})
    GROUP BY 1, 2
  `);

  const byUic = new Map<string, UnitAllocation>(
    page
      .filter((t): t is typeof t & { deviceUIC: string } => t.deviceUIC !== null)
      .map((t) => [t.deviceUIC, { uic: t.deviceUIC, total: t._count._all, deployed: 0, ready: 0 }]),
  );
  for (const r of breakdown) {
    const entry = byUic.get(r.uic);
    if (!entry) continue;
    if (r.readiness === "DEPLOYED") entry.deployed += Number(r.count);
    if (r.readiness === "READY_TO_DEPLOY") entry.ready += Number(r.count);
  }
  return { rows: [...byUic.values()].sort((a, b) => b.total - a.total), truncated };
}

/* ------------------------------------------------------------
   Page loader — every widget in one round of parallel queries.
   ------------------------------------------------------------ */

export type DashboardData = Awaited<ReturnType<typeof getDashboard>>;

export async function getDashboard(uic: UicFilter, range: RangeKey) {
  const [units, auditReadiness, kpis, velocity, allocations, fleetTotal, vocabulary] =
    await Promise.all([
      listUnitOptions(),
      getAuditReadiness(uic),
      getFleetKpis(uic),
      getTransferVelocity(uic, range),
      getUnitAllocations(),
      prisma.item.count({ where: itemWhere(uic) }),
      // The full category vocabulary, in a stable order. Deliberately NOT
      // scoped by the UIC filter: it is the chart's COLOUR KEY, so it must be
      // identical whichever unit is selected, or series get repainted.
      prisma.deviceCategory
        .findMany({ select: { name: true }, orderBy: { name: "asc" }, take: 200 })
        .then((rows) => rows.map((r) => r.name)),
    ]);

  return { units, auditReadiness, kpis, velocity, allocations, fleetTotal, vocabulary };
}
