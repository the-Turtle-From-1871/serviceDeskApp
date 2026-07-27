import { redirect } from "next/navigation";
import Link from "next/link";
import { requireAdmin, AuthError } from "@/lib/authz";
import { getDashboard, isRangeKey, type RangeKey } from "./analytics.service";
import { UnitFilter } from "./Filters";
import {
  AccountabilityWidget,
  FleetKpiWidget,
  StatusOverTimeWidget,
  UnitLeaderboardWidget,
  VelocityWidget,
} from "./widgets";

export const metadata = { title: "Readiness analytics" };

/**
 * Operational-readiness dashboard.
 *
 * ADMIN-ONLY. It aggregates the whole catalogue across every unit, which is a
 * broader view than the per-item pages a standard USER can reach, so it is
 * gated with requireAdmin() like the rest of /admin. requireAdmin re-reads
 * role + isActive from the DB per request, so a demotion takes effect on the
 * next navigation.
 *
 * All state lives in the URL (?uic=&range=), so every widget is re-queried on
 * the server whenever a filter changes — there is exactly one filtering
 * implementation, and it is the SQL one.
 */
export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ uic?: string; range?: string }>;
}) {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) redirect(e.code === "FORBIDDEN" ? "/" : "/login");
    throw e;
  }

  const sp = await searchParams;
  // Never trust the querystring: an unknown range falls back to the default
  // rather than reaching the SQL bucket interval.
  const range: RangeKey = sp.range && isRangeKey(sp.range) ? sp.range : "90d";
  const uic = sp.uic?.trim() ? sp.uic.trim() : null;

  const { units, accountability, kpis, statusOverTime, velocity, allocations, fleetTotal } =
    await getDashboard(uic, range);

  return (
    <div className="stack">
      <div className="row">
        <div>
          <h1 className="page-title">Readiness analytics</h1>
          <p className="subtle">
            {fleetTotal} item{fleetTotal === 1 ? "" : "s"} in scope
            {uic ? ` · unit ${uic}` : " · all units"}
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
            <UnitFilter units={units} value={uic} />
            {units.length === 0 && (
              <span className="text-xs text-muted-foreground">
                No UICs found — import a CSV with a <code>UIC</code> column to enable this filter.
              </span>
            )}
          </div>
        </div>

        <AccountabilityWidget data={accountability} uic={uic} />

        <FleetKpiWidget
          totalDeployed={kpis.totalDeployed}
          totalReady={kpis.totalReady}
          byCategory={kpis.byCategory}
        />

        <div className="lg:col-span-2">
          <StatusOverTimeWidget data={statusOverTime} range={range} uic={uic} />
        </div>

        <div className="lg:col-span-2">
          <VelocityWidget
            points={velocity.points}
            categories={velocity.categories}
            range={range}
            uic={uic}
          />
        </div>

        <div className="lg:col-span-2">
          <UnitLeaderboardWidget rows={allocations.rows} truncated={allocations.truncated} selected={uic} />
        </div>
      </div>
    </div>
  );
}
