"use client";

import { CheckCircle2, AlertTriangle, PackageCheck, Truck } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { ChartCard } from "./ChartCard";
import { DonutChart, StackedAreaChart, StackedBarChart } from "./charts";
import { RangeToggle, useSetParam } from "./Filters";
import {
  ACCOUNTED_COLOR,
  NOT_ACCOUNTED_COLOR,
  OTHER_COLOR,
  STATUS_COLOR,
  colorForIndex,
  foldCategories,
} from "./palette";
import {
  DEPLOYABLE_STATUSES,
  STATUS_LABEL,
  UNTRIAGED,
  type AccountabilitySlice,
  type CategoryKpi,
  type RangeKey,
  type StatusPoint,
  type UnitAllocation,
  type VelocityPoint,
} from "./analytics.types";

/* ------------------------------------------------------------
   Date formatting for the two time-series axes.
   ------------------------------------------------------------ */

const dayFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const monthFmt = new Intl.DateTimeFormat("en-US", { month: "short", year: "2-digit" });

const formatDay = (iso: string) => dayFmt.format(new Date(iso));
const formatMonth = (iso: string) => monthFmt.format(new Date(iso));

/* ------------------------------------------------------------
   Widget 1 — Audit readiness.
   ------------------------------------------------------------ */

export function AccountabilityWidget({
  data,
  uic,
}: {
  data: AccountabilitySlice[];
  // Deliberately takes no `range`: this donut is a point-in-time snapshot of
  // the current fleet and does not read the time filter at all.
  uic: string | null;
}) {
  const accounted = data.find((d) => d.accountedFor)?.count ?? 0;
  const missing = data.find((d) => !d.accountedFor)?.count ?? 0;
  const total = accounted + missing;
  const pct = total ? Math.round((accounted / total) * 100) : 0;

  const slices = [
    { label: "Accounted for", value: accounted, color: ACCOUNTED_COLOR },
    { label: "Not accounted for", value: missing, color: NOT_ACCOUNTED_COLOR },
  ];
  // A zero-total fleet must not render a donut of two empty wedges.
  const rows = total === 0 ? [] : slices.map((s) => ({ Status: s.label, Items: s.value }));

  return (
    <ChartCard
      title="Audit readiness"
      description={total ? `${pct}% of ${total} items accounted for` : "No items in scope"}
      legend={slices.map((s) => ({ label: s.label, color: s.color }))}
      exportBase="audit-readiness"
      // No range in the filename: this donut is a point-in-time snapshot and
      // ignores the time range entirely, so tagging the file "90d" would lie.
      exportParts={[uic ?? "all-units"]}
      exportColumns={["Status", "Items"]}
      exportRows={rows}
    >
      <div className="relative">
        <DonutChart data={slices} />
        {/* Direct label in the hole: the headline number should not require
            reading a tooltip or matching a colour. */}
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-semibold tabular-nums text-foreground">{pct}%</span>
          <span className="text-xs text-muted-foreground">accounted for</span>
        </div>
      </div>
      {/* Icon + label pairing, so the good/problem split never rests on hue. */}
      <div className="mt-2 flex flex-wrap justify-center gap-x-5 gap-y-1 text-xs">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <CheckCircle2 className="size-3.5" style={{ color: ACCOUNTED_COLOR }} aria-hidden="true" />
          {accounted} accounted for
        </span>
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <AlertTriangle className="size-3.5" style={{ color: NOT_ACCOUNTED_COLOR }} aria-hidden="true" />
          {missing} missing
        </span>
      </div>
    </ChartCard>
  );
}

/* ------------------------------------------------------------
   Widget 2 — Fleet KPIs. Stat tiles, not a chart: two headline
   magnitudes plus a small breakdown read better as numbers.
   ------------------------------------------------------------ */

export function FleetKpiWidget({
  totalDeployed,
  totalReady,
  byCategory,
}: {
  totalDeployed: number;
  totalReady: number;
  byCategory: CategoryKpi[];
}) {
  return (
    // h-full + flex column so this card matches the height of the donut card
    // beside it, and the category list scrolls INSIDE the card instead of
    // being clipped mid-row by a fixed max-height.
    <Card className="flex h-full flex-col">
      <CardHeader>
        <CardTitle>Fleet status</CardTitle>
        <CardDescription>In service vs ready to deploy, by category</CardDescription>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-4">
        <div className="grid shrink-0 grid-cols-2 gap-3">
          <StatTile
            icon={<Truck className="size-4" aria-hidden="true" />}
            label="In service"
            sublabel="Deployed"
            value={totalDeployed}
          />
          <StatTile
            icon={<PackageCheck className="size-4" aria-hidden="true" />}
            label="Ready"
            sublabel="Ready to deploy"
            value={totalReady}
          />
        </div>

        {byCategory.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No items are marked deployed or ready in this scope yet.
          </p>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Category</TableHead>
                  <TableHead className="text-right">In service</TableHead>
                  <TableHead className="text-right">Ready</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {byCategory.map((c) => (
                  <TableRow key={c.category}>
                    <TableCell className="font-medium">{c.category}</TableCell>
                    <TableCell className="text-right tabular-nums">{c.deployed}</TableCell>
                    <TableCell className="text-right tabular-nums">{c.ready}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function StatTile({
  icon,
  label,
  sublabel,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  sublabel: string;
  value: number;
}) {
  return (
    <div className="rounded-ledger border border-border bg-surface-2 p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-1 text-3xl font-semibold tabular-nums text-foreground">{value}</div>
      <div className="text-xs text-text-subtle">{sublabel}</div>
    </div>
  );
}

/* ------------------------------------------------------------
   Widget 3 — Fleet status over time.
   ------------------------------------------------------------ */

const STATUS_SERIES = [...DEPLOYABLE_STATUSES, UNTRIAGED].map((key) => ({
  key,
  label: STATUS_LABEL[key],
  color: STATUS_COLOR[key],
}));

export function StatusOverTimeWidget({
  data,
  range,
  uic,
}: {
  data: StatusPoint[];
  range: RangeKey;
  uic: string | null;
}) {
  const rows = data.map((p) => {
    const row: Record<string, unknown> = { Date: formatDay(p.date) };
    for (const s of STATUS_SERIES) row[s.label] = p[s.key] ?? 0;
    return row;
  });

  return (
    <ChartCard
      title="Fleet status over time"
      description="Readiness composition at each point in the window"
      controls={<RangeToggle value={range} />}
      legend={STATUS_SERIES.map((s) => ({ label: s.label, color: s.color }))}
      exportBase="fleet-status"
      exportParts={[range, uic ?? "all-units"]}
      exportColumns={["Date", ...STATUS_SERIES.map((s) => s.label)]}
      exportRows={rows}
    >
      <StackedAreaChart data={data} series={STATUS_SERIES} xKey="date" formatX={formatDay} />
    </ChartCard>
  );
}

/* ------------------------------------------------------------
   Widget 4 — DA Form 2062 velocity.
   ------------------------------------------------------------ */

export function VelocityWidget({
  points,
  categories,
  range,
  uic,
}: {
  points: VelocityPoint[];
  categories: string[];
  range: RangeKey;
  uic: string | null;
}) {
  // Past 8 categories the palette is not extended — the tail folds into
  // "Other" rather than inventing hues that would fail CVD separation.
  const { kept, folded, overflowLabel } = foldCategories(categories);
  const series = kept.map((c, i) => ({
    key: c,
    label: c,
    color: c === overflowLabel ? OTHER_COLOR : colorForIndex(i),
  }));

  const data = points.map((p) => {
    const row: Record<string, unknown> = { month: p.month };
    let other = 0;
    for (const c of categories) {
      const v = Number(p[c] ?? 0);
      if (folded.has(c)) other += v;
      else row[c] = v;
    }
    // Key the overflow row by the exact label foldCategories used.
    if (overflowLabel) row[overflowLabel] = other;
    return row;
  });

  const rows = data.map((d) => {
    const row: Record<string, unknown> = { Month: formatMonth(String(d.month)) };
    for (const s of series) row[s.label] = d[s.key] ?? 0;
    return row;
  });

  return (
    <ChartCard
      title="DA Form 2062 velocity"
      // Says exactly what is counted — see the note in analytics.service.ts on
      // why this is items, not receipts.
      description="Items transferred on completed hand receipts, per month. Closed receipts are purged after 90 days, so earlier months may under-report."
      controls={<RangeToggle value={range} />}
      legend={series.map((s) => ({ label: s.label, color: s.color }))}
      exportBase="transfer-velocity"
      exportParts={[range, uic ?? "all-units"]}
      exportColumns={["Month", ...series.map((s) => s.label)]}
      exportRows={rows}
    >
      <StackedBarChart data={data} series={series} xKey="month" formatX={formatMonth} />
    </ChartCard>
  );
}

/* ------------------------------------------------------------
   Widget 5 — Unit allocation leaderboard.
   ------------------------------------------------------------ */

export function UnitLeaderboardWidget({
  rows,
  truncated,
  selected,
}: {
  rows: UnitAllocation[];
  truncated: boolean;
  selected: string | null;
}) {
  const { setParam, pending } = useSetParam();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Unit allocation</CardTitle>
        <CardDescription>
          Items assigned per UIC. Select a unit to scope the whole dashboard.
          {truncated && " Showing the largest units only."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No items have a UIC yet. Import a CSV with a <code>UIC</code> column to populate this.
          </p>
        ) : (
          <div className="max-h-[320px] overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Unit (UIC)</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Deployed</TableHead>
                  <TableHead className="text-right">Ready</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const isSelected = r.uic === selected;
                  return (
                    <TableRow key={r.uic} data-state={isSelected ? "selected" : undefined}>
                      <TableCell>
                        {/* A button, not a row click: the action must be
                            keyboard reachable and announced as a control. */}
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={pending}
                          aria-pressed={isSelected}
                          onClick={() => setParam("uic", isSelected ? null : r.uic)}
                          // h-auto deliberately overrides the button's height
                          // so the row stays compact on desktop; the coarse-
                          // pointer floor is restored explicitly, or this ends
                          // up a 22px tap target on a phone.
                          className="h-auto px-1 py-0.5 font-medium pointer-coarse:min-h-11 pointer-coarse:px-3 max-md:min-h-11 max-md:px-3"
                        >
                          {r.uic}
                        </Button>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{r.total}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.deployed}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.ready}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
