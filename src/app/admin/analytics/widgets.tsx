"use client";

import { CheckCircle2, AlertTriangle, CircleHelp, PackageCheck, Truck } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { ChartCard } from "./ChartCard";
import { DonutChart, StackedBarChart } from "./charts";
import { GroupByFilter, RangeToggle, useSetParam } from "./Filters";
import {
  AUDIT_STATE_COLOR,
  OTHER_COLOR,
  foldCategories,
  makeCategoryColor,
} from "./palette";
import {
  AUDIT_STATE_ORDER,
  GROUP_BY,
  UNASSIGNED,
  scopeLabel,
  type AuditReadinessSlice,
  type CategoryKpi,
  type GroupByKey,
  type ItemScope,
  type RangeKey,
  type UnitAllocation,
  type VelocityPoint,
} from "./analytics.types";

/* ------------------------------------------------------------
   Date formatting for the velocity axis.
   ------------------------------------------------------------ */

/* Pinned to HST, like every other date in this app (see lib/datetime.ts).
   Without an explicit timeZone these render in the VIEWER's zone, and because
   the SQL buckets are UTC midnights, an HST viewer (UTC−10) sees each one as
   14:00 the PREVIOUS day — which silently labels every month bar, and every
   exported CSV row, one month early. */
const HST = "Pacific/Honolulu";

const monthFmt = new Intl.DateTimeFormat("en-US", { timeZone: HST, month: "short", year: "2-digit" });

/** A month bucket arrives as the UTC instant that starts the month. Formatting
 *  that instant in HST would roll it back into the previous month, so nudge to
 *  midday UTC first: the label names the BUCKET, not a moment in time. */
const formatMonth = (iso: string) => monthFmt.format(new Date(new Date(iso).getTime() + 12 * 60 * 60 * 1000));

/* ------------------------------------------------------------
   Widget 1 — Audit readiness.
   ------------------------------------------------------------ */

/** Label + icon per audit state. The icon is not decoration: it is the secondary
 *  encoding that keeps the three states legible without colour (the yellow slot
 *  also sits under 3:1 on the ledger surface — see palette.ts). */
const AUDIT_STATE_UI = {
  compliant: { label: "Audited (current)", Icon: CheckCircle2 },
  overdue: { label: "Audit overdue", Icon: AlertTriangle },
  never: { label: "Never audited", Icon: CircleHelp },
} as const;

export function AuditReadinessWidget({
  data,
  scope,
}: {
  data: AuditReadinessSlice[];
  // Deliberately takes no `range`: this donut is a point-in-time snapshot of
  // the current fleet and does not read the time filter at all.
  scope: ItemScope;
}) {
  const countOf = (state: (typeof AUDIT_STATE_ORDER)[number]) =>
    data.find((d) => d.state === state)?.count ?? 0;
  const total = data.reduce((sum, d) => sum + d.count, 0);
  const compliant = countOf("compliant");
  const pct = total ? Math.round((compliant / total) * 100) : 0;

  const slices = AUDIT_STATE_ORDER.map((state) => ({
    label: AUDIT_STATE_UI[state].label,
    value: countOf(state),
    color: AUDIT_STATE_COLOR[state],
  }));
  // A zero-total fleet must not render a donut of empty wedges.
  const rows = total === 0 ? [] : slices.map((s) => ({ Status: s.label, Items: s.value }));

  return (
    <ChartCard
      title="Audit readiness"
      // Says what the number MEANS. Accountability is claimed from audit
      // evidence, so an unaudited item is not counted as accounted for.
      description={
        total ? `${pct}% of ${total} items audited within the last year` : "No items in scope"
      }
      legend={slices.map((s) => ({ label: s.label, color: s.color }))}
      // Matches the icon+count row above it, which is centred under the donut.
      legendAlign="center"
      exportBase="audit-readiness"
      // No range in the filename: this donut is a point-in-time snapshot and
      // ignores the time range entirely, so tagging the file "90d" would lie.
      exportParts={[scopeLabel(scope)]}
      exportColumns={["Status", "Items"]}
      exportRows={rows}
    >
      <div className="relative">
        <DonutChart data={slices} />
        {/* Direct label in the hole: the headline number should not require
            reading a tooltip or matching a colour. */}
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-semibold tabular-nums text-foreground">{pct}%</span>
          <span className="text-xs text-muted-foreground">audited</span>
        </div>
      </div>
      {/* Icon + label + count per state, so identity never rests on hue alone. */}
      <div className="mt-2 flex flex-wrap justify-center gap-x-5 gap-y-1 text-xs">
        {AUDIT_STATE_ORDER.map((state) => {
          const { label, Icon } = AUDIT_STATE_UI[state];
          return (
            <span key={state} className="flex items-center gap-1.5 text-muted-foreground">
              <Icon className="size-3.5" style={{ color: AUDIT_STATE_COLOR[state] }} aria-hidden="true" />
              {countOf(state)} {label.toLowerCase()}
            </span>
          );
        })}
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
   Widget 3 — DA Form 2062 velocity.

   The "Fleet status over time" stacked area used to sit here. It is gone
   along with the stored readiness enum and its history table: readiness is
   now derived from live signals, so there is no timeline to plot and drawing
   one would mean inventing it. See analytics.service.ts for the full note.
   ------------------------------------------------------------ */

export function VelocityWidget({
  points,
  categories,
  vocabulary,
  range,
  scope,
}: {
  points: VelocityPoint[];
  /** Present in the current result, ordered by volume desc (folding order). */
  categories: string[];
  /** EVERY known category, in a stable order — the colour key. Separate from
   *  `categories` on purpose: colour must not change when a filter changes
   *  which categories happen to have data. */
  vocabulary: string[];
  range: RangeKey;
  scope: ItemScope;
}) {
  // Past 8 categories the palette is not extended — the tail folds into
  // "Other" rather than inventing hues that would fail CVD separation.
  const { kept, folded, overflowLabel } = foldCategories(categories);
  const colorFor = makeCategoryColor(vocabulary);
  const series = kept.map((c) => ({
    key: c,
    label: c,
    color: c === overflowLabel ? OTHER_COLOR : colorFor(c),
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
      title="DA Form 2062 volume"
      // Says exactly what is counted — see the note in analytics.service.ts on
      // why this is items, not receipts.
      description="Items transferred on completed hand receipts, per month. Closed receipts are purged after 90 days, so earlier months may under-report."
      controls={<RangeToggle value={range} />}
      legend={series.map((s) => ({ label: s.label, color: s.color }))}
      exportBase="transfer-volume"
      exportParts={[range, scopeLabel(scope)]}
      exportColumns={["Month", ...series.map((s) => s.label)]}
      exportRows={rows}
    >
      <StackedBarChart data={data} series={series} xKey="month" formatX={formatMonth} />
    </ChartCard>
  );
}

/* ------------------------------------------------------------
   Widget 4 — Unit allocation leaderboard.
   ------------------------------------------------------------ */

export function UnitLeaderboardWidget({
  rows,
  truncated,
  groupBy,
  selected,
}: {
  rows: UnitAllocation[];
  truncated: boolean;
  /** Which dimension the server grouped by — drives the header, the wording,
   *  and which URL param a row click writes. */
  groupBy: GroupByKey;
  /** The active filter value FOR THIS DIMENSION (`?unit=` or `?uic=`). The
   *  other dimension's filter may also be set; it just highlights nothing. */
  selected: string | null;
}) {
  const { setParam, pending } = useSetParam();
  const { column, noun, param } = GROUP_BY[groupBy];

  return (
    <Card>
      <CardHeader className="flex flex-row items-start gap-3">
        <div className="min-w-0 flex-1">
          <CardTitle>Unit allocation</CardTitle>
          <CardDescription>
            Items assigned per {noun}. Select a row to scope the whole dashboard.
            {truncated && " Showing the largest units only."}
          </CardDescription>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-sm text-muted-foreground max-sm:sr-only">Group by</span>
          <GroupByFilter value={groupBy} />
        </div>
      </CardHeader>
      <CardContent>
        {/* Items with no value in this dimension are their own row, so an empty
            table now means an empty catalogue — not "nothing is labelled". */}
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No active items in the catalogue yet.
          </p>
        ) : (
          <div className="max-h-[320px] overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{column}</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Deployed</TableHead>
                  <TableHead className="text-right">Ready</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const isSelected = r.value !== null && r.value === selected;
                  return (
                    <TableRow
                      key={r.value ?? UNASSIGNED}
                      data-state={isSelected ? "selected" : undefined}
                    >
                      <TableCell>
                        {r.value === null ? (
                          // Counted and shown so the Total column still sums to
                          // the fleet, but NOT a control: "no unit" is the
                          // absence of a filter value, so there is nothing for a
                          // click to put in the URL.
                          <span className="px-1 font-medium italic text-muted-foreground">
                            {UNASSIGNED}
                          </span>
                        ) : (
                          /* A button, not a row click: the action must be
                             keyboard reachable and announced as a control. */
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={pending}
                            aria-pressed={isSelected}
                            onClick={() => setParam(param, isSelected ? null : r.value)}
                            // h-auto deliberately overrides the button's height
                            // so the row stays compact on desktop; the coarse-
                            // pointer floor is restored explicitly, or this ends
                            // up a 22px tap target on a phone.
                            className="h-auto px-1 py-0.5 text-left font-medium whitespace-normal pointer-coarse:min-h-11 pointer-coarse:px-3 max-md:min-h-11 max-md:px-3"
                          >
                            {r.value}
                          </Button>
                        )}
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
