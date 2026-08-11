import { redirect } from "next/navigation";
import Link from "next/link";
import { requireCapability, AuthError } from "@/lib/authz";
import {
  getDashboard,
  isRangeKey,
  isGroupByKey,
  scopeLabel,
  DEFAULT_GROUP_BY,
  type GroupByKey,
  type ItemScope,
  type RangeKey,
} from "./analytics.service";
import { firstParam } from "@/lib/search-params";
import { UnitFilter } from "./Filters";
import { StaleDevicesCard } from "./StaleDevicesCard";
import { DroppedDevicesCard } from "./DroppedDevicesCard";
import {
  AuditReadinessWidget,
  FleetKpiWidget,
  UnitLeaderboardWidget,
  VelocityWidget,
} from "./widgets";

export const metadata = { title: "Readiness analytics" };

/**
 * Operational-readiness dashboard.
 *
 * ADMIN-ONLY. It aggregates the whole catalogue across every unit, which is a
 * broader view than the per-item pages a standard USER can reach, so it is
 * gated with requireCapability("VIEW_ANALYTICS") like the rest of /admin. requireCapability re-reads
 * role + isActive from the DB per request, so a demotion takes effect on the
 * next navigation.
 *
 * All state lives in the URL (?uic=&unit=&range=&groupBy=), so every widget is
 * re-queried on the server whenever a filter changes — there is exactly one
 * filtering implementation, and it is the SQL one. `groupBy` included: it picks
 * the column the allocation table GROUPs BY, so it must reach the query.
 */
export default async function AnalyticsPage({
  searchParams,
}: {
  // string[] is reachable: Next supplies an array whenever a key is repeated.
  searchParams: Promise<{
    uic?: string | string[];
    unit?: string | string[];
    range?: string | string[];
    groupBy?: string | string[];
  }>;
}) {
  try {
    await requireCapability("VIEW_ANALYTICS");
  } catch (e) {
    if (e instanceof AuthError) redirect(e.code === "FORBIDDEN" ? "/" : "/login");
    throw e;
  }

  const sp = await searchParams;
  // Never trust the querystring: an unknown range falls back to the default
  // rather than reaching the SQL bucket interval, and firstParam collapses the
  // repeated-key array form before anything calls a string method on it.
  const rawRange = firstParam(sp.range);
  const range: RangeKey = rawRange && isRangeKey(rawRange) ? rawRange : "90d";
  const rawGroupBy = firstParam(sp.groupBy);
  const groupBy: GroupByKey =
    rawGroupBy && isGroupByKey(rawGroupBy) ? rawGroupBy : DEFAULT_GROUP_BY;
  // The two filter dimensions are independent and compose (see ItemScope): the
  // header Select writes ?uic=, the allocation table writes whichever param
  // matches the dimension it is showing.
  const rawUic = firstParam(sp.uic)?.trim();
  const rawUnit = firstParam(sp.unit)?.trim();
  const scope: ItemScope = { uic: rawUic ? rawUic : null, unit: rawUnit ? rawUnit : null };

  const {
    units,
    auditReadiness,
    kpis,
    velocity,
    allocations,
    fleetTotal,
    staleDeviceCount,
    droppedDeviceCount,
    vocabulary,
  } = await getDashboard(scope, range, groupBy);

  return (
    <div className="stack">
      <div className="row">
        <div>
          <h1 className="page-title">Readiness analytics</h1>
          <p className="subtle">
            {fleetTotal} item{fleetTotal === 1 ? "" : "s"} in scope
            {` · ${scopeLabel(scope)}`}
          </p>
        </div>
        <Link href="/admin" className="btn btn-secondary spacer">
          Back to admin
        </Link>
      </div>

      {/* Global filters on top, charts in the middle, unit distribution at the
          bottom — a single CSS Grid that collapses to one column on phones. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="lg:col-span-2">
          <div className="flex flex-wrap items-center gap-3 rounded-ledger border border-border bg-card p-3">
            <span className="text-sm font-medium text-foreground">Unit</span>
            <UnitFilter units={units} value={scope.uic} />
            {units.length === 0 && (
              <span className="text-xs text-muted-foreground">
                No UICs found — import a CSV with a <code>UIC</code> column to enable this filter.
              </span>
            )}
          </div>
        </div>

        {/* Sits directly under the filters and above the charts: it is the one
            thing on this page that produces a work list rather than a reading,
            and it is scoped by the same filter bar it sits beneath. */}
        <div className="lg:col-span-2">
          <StaleDevicesCard count={staleDeviceCount} scope={scope} />
        </div>

        {/* Directly beneath its sibling, because the two are read together and
            the pair is the point: the card above counts devices MDM saw 30-90
            days ago, this one counts the devices it cannot see at all. Split
            apart on the page, the second reads as a duplicate of the first. */}
        <div className="lg:col-span-2">
          <DroppedDevicesCard count={droppedDeviceCount} scope={scope} />
        </div>

        <AuditReadinessWidget data={auditReadiness} scope={scope} />

        <FleetKpiWidget
          totalDeployed={kpis.totalDeployed}
          totalReady={kpis.totalReady}
          byCategory={kpis.byCategory}
        />

        <div className="lg:col-span-2">
          <VelocityWidget
            points={velocity.points}
            categories={velocity.categories}
            vocabulary={vocabulary}
            range={range}
            scope={scope}
          />
        </div>

        <div className="lg:col-span-2">
          <UnitLeaderboardWidget
            rows={allocations.rows}
            truncated={allocations.truncated}
            groupBy={groupBy}
            // Highlight the row matching the filter FOR THE DISPLAYED
            // dimension; the other dimension's filter is reported in the header
            // line instead.
            selected={groupBy === "uic" ? scope.uic : scope.unit}
          />
        </div>
      </div>
    </div>
  );
}
