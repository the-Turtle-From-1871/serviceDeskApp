import "server-only";
import { Prisma, type DeployableStatus } from "@prisma/client";
import prisma from "@/lib/prisma";
import { listItemUics } from "@/modules/items/items.service";

/* ============================================================
   Analytics aggregation for the readiness dashboard.

   Every function here obeys the project's non-negotiable data-fetching
   rules (CLAUDE.md): aggregate in SQL with groupBy, never query inside a
   loop, select only what is rendered, and bound every list. The whole
   page is five queries plus one for the filter's option list — it does
   not grow with the size of the fleet.

   Every widget honours the same optional `deviceUIC` filter, so the
   global Select at the top of the page re-scopes the entire view.
   ============================================================ */

import {
  DEPLOYABLE_STATUSES,
  RANGES,
  UNCATEGORIZED,
  UNTRIAGED,
  statusKey,
  type AccountabilitySlice,
  type CategoryKpi,
  type RangeKey,
  type StatusPoint,
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
 * Lifecycle-RETIRED items are EXCLUDED. They are decommissioned kit, and
 * because `isAccountedFor` defaults to true they would otherwise pad the
 * "accounted for" numerator and the unit totals with equipment nobody is
 * responsible for finding — readiness figures that quietly overstate.
 * The rest of the app already treats retired as out of scope (`/items`
 * renders no audit state for them).
 *
 * NOTE the two different RETIREDs: `Item.status` is the ACTIVE/RETIRED
 * lifecycle filtered here; `deployableStatus: "RETIRED"` is a readiness
 * state and remains a legitimate series in the charts.
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

export async function getAccountability(uic: UicFilter): Promise<AccountabilitySlice[]> {
  const rows = await prisma.item.groupBy({
    by: ["isAccountedFor"],
    where: itemWhere(uic),
    _count: { _all: true },
  });
  // Always emit both slices so the donut's legend is stable even when one
  // side is empty (an all-accounted-for fleet must still show "0 missing").
  return [true, false].map((accountedFor) => ({
    accountedFor,
    count: rows.find((r) => r.isAccountedFor === accountedFor)?._count._all ?? 0,
  }));
}

/* ------------------------------------------------------------
   Widget 2 — Fleet KPIs: In Service vs Ready, by category.
   ------------------------------------------------------------ */

export async function getFleetKpis(uic: UicFilter): Promise<{
  totalDeployed: number;
  totalReady: number;
  byCategory: CategoryKpi[];
}> {
  // ONE grouped query covers both statuses and every category — not one
  // query per status, and not one per category.
  const rows = await prisma.item.groupBy({
    by: ["deviceCategory", "deployableStatus"],
    where: { ...itemWhere(uic), deployableStatus: { in: ["DEPLOYED", "READY_TO_DEPLOY"] } },
    _count: { _all: true },
  });

  const byCategory = new Map<string, CategoryKpi>();
  let totalDeployed = 0;
  let totalReady = 0;

  for (const r of rows) {
    const category = r.deviceCategory ?? UNCATEGORIZED;
    const entry = byCategory.get(category) ?? { category, deployed: 0, ready: 0 };
    const n = r._count._all;
    if (r.deployableStatus === "DEPLOYED") {
      entry.deployed += n;
      totalDeployed += n;
    } else if (r.deployableStatus === "READY_TO_DEPLOY") {
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
   Widget 3 — Fleet status over time.
   ------------------------------------------------------------ */

type StatusHistoryRow = { ts: Date; deployableStatus: DeployableStatus | null; count: number };

/**
 * Composition of the fleet at each bucket boundary, from ItemStatusHistory.
 *
 * The history table stores SNAPSHOTS (state after each change), so an item's
 * state at instant T is simply its newest row at or before T — that is the
 * `DISTINCT ON (bucket, itemId) ... ORDER BY createdAt DESC` below. No delta
 * replay, and no per-bucket round trip: the whole series is one query.
 *
 * KNOWN COST — read before scaling this up. Only the OUTPUT is bounded (RANGES
 * caps a window at ~90 buckets). The join itself is buckets x |history|,
 * because `h."createdAt" <= b.ts` has no lower bound: every history row ever
 * written pairs with every bucket at or after it, and the whole product is
 * sorted for the DISTINCT ON. At ~1,200 items with a monthly readiness sweep
 * that is fine for years; at high write volume it will not be. Fixing it is
 * NOT as simple as adding `h."createdAt" >= start` — that drops the carry-in
 * state for items untouched during the window, silently shrinking the fleet.
 * The correct rewrite is a per-item last-known-state LATERAL seeded at `start`
 * plus in-window changes. Deliberately not done here: the current form is
 * correct, and the volume that makes it slow does not exist yet.
 */
export async function getStatusOverTime(uic: UicFilter, range: RangeKey): Promise<StatusPoint[]> {
  const { days, bucket } = RANGES[range];
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);

  // Parameterized $queryRaw — never string interpolation (CLAUDE.md §2).
  const rows = await prisma.$queryRaw<StatusHistoryRow[]>(Prisma.sql`
    WITH buckets AS (
      SELECT generate_series(${start}::timestamptz, ${end}::timestamptz, ${bucket}::interval) AS ts
    ),
    snap AS (
      SELECT DISTINCT ON (b.ts, h."itemId")
             b.ts AS ts,
             h."deployableStatus" AS "deployableStatus"
      FROM buckets b
      JOIN "ItemStatusHistory" h ON h."createdAt" <= b.ts
      JOIN "Item" i ON i."id" = h."itemId"
      WHERE i."status" = 'ACTIVE'
        AND (${uic}::text IS NULL OR i."deviceUIC" = ${uic}::text)
      ORDER BY b.ts, h."itemId", h."createdAt" DESC
    )
    SELECT ts, "deployableStatus", COUNT(*)::int AS count
    FROM snap
    GROUP BY ts, "deployableStatus"
    ORDER BY ts
  `);

  // Pivot to one object per bucket, zero-filling every series so the stacked
  // areas are continuous rather than breaking wherever a status had no items.
  const byTs = new Map<number, StatusPoint>();
  for (const r of rows) {
    const t = r.ts.getTime();
    let point = byTs.get(t);
    if (!point) {
      point = { date: r.ts.toISOString() };
      for (const s of [...DEPLOYABLE_STATUSES, UNTRIAGED]) point[s] = 0;
      byTs.set(t, point);
    }
    point[statusKey(r.deployableStatus)] = Number(r.count);
  }
  return [...byTs.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
}

/* ------------------------------------------------------------
   Widget 4 — DA Form 2062 velocity.
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
   Widget 5 — Unit allocation leaderboard.
   ------------------------------------------------------------ */

/**
 * Per-UIC totals. TWO grouped queries regardless of how many units exist —
 * never one per unit.
 *
 * Why not a single `groupBy(["deviceUIC","deployableStatus"], { take })`:
 * `take` bounds the number of GROUPS, and each unit produces up to one group
 * per status. A cap would slice through the middle of a unit and report that
 * unit's totals as short — silently wrong numbers, which is worse than a
 * visible truncation. So: pick the top N units first (query 1), then fetch
 * the status breakdown for exactly those units (query 2).
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

  const breakdown = await prisma.item.groupBy({
    by: ["deviceUIC", "deployableStatus"],
    // MUST carry the same status: "ACTIVE" scope as the totals query above.
    // Without it the Deployed/Ready columns count lifecycle-retired kit that
    // Total excludes, so a unit with retired-but-still-DEPLOYED items can show
    // Deployed + Ready greater than its Total.
    where: { status: "ACTIVE", deviceUIC: { in: uics } },
    _count: { _all: true },
  });

  const byUic = new Map<string, UnitAllocation>(
    page
      .filter((t): t is typeof t & { deviceUIC: string } => t.deviceUIC !== null)
      .map((t) => [t.deviceUIC, { uic: t.deviceUIC, total: t._count._all, deployed: 0, ready: 0 }]),
  );
  for (const r of breakdown) {
    if (!r.deviceUIC) continue;
    const entry = byUic.get(r.deviceUIC);
    if (!entry) continue;
    if (r.deployableStatus === "DEPLOYED") entry.deployed += r._count._all;
    if (r.deployableStatus === "READY_TO_DEPLOY") entry.ready += r._count._all;
  }
  return { rows: [...byUic.values()].sort((a, b) => b.total - a.total), truncated };
}

/* ------------------------------------------------------------
   Page loader — every widget in one round of parallel queries.
   ------------------------------------------------------------ */

export type DashboardData = Awaited<ReturnType<typeof getDashboard>>;

export async function getDashboard(uic: UicFilter, range: RangeKey) {
  const [units, accountability, kpis, statusOverTime, velocity, allocations, fleetTotal, vocabulary] =
    await Promise.all([
      listUnitOptions(),
      getAccountability(uic),
      getFleetKpis(uic),
      getStatusOverTime(uic, range),
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

  return { units, accountability, kpis, statusOverTime, velocity, allocations, fleetTotal, vocabulary };
}
