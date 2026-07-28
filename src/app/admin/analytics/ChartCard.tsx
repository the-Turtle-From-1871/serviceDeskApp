"use client";

import { useId, useRef, useState } from "react";
import { Download, Image as ImageIcon, MoreHorizontal, Table2, BarChart3 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { downloadCsv, downloadPng, exportName } from "./export";

export type LegendEntry = { label: string; color: string };

type Props = {
  title: string;
  description?: string;
  /** Rendered above the chart, right-aligned — the range ToggleGroup. */
  controls?: React.ReactNode;
  /** ≥2 series always get a legend; identity is never colour alone. */
  legend?: LegendEntry[];
  /** Centre the legend under the plot. Defaults to start-aligned, which lines
   *  the swatches up with the y-axis of a cartesian chart. A donut has no axis
   *  to align to and is itself centred, so a start-aligned legend reads as
   *  detached from it — see AuditReadinessWidget. */
  legendAlign?: "start" | "center";
  /** Raw rows behind the chart. Powers both the CSV export and the table view. */
  exportColumns: string[];
  exportRows: Array<Record<string, unknown>>;
  /** Parts folded into the export filename (range, selected unit). */
  exportParts: Array<string | null | undefined>;
  exportBase: string;
  children: React.ReactNode;
};

/**
 * Shared shell for every chart on the dashboard.
 *
 * The "View as table" mode is NOT a nice-to-have. Three slots of the
 * validated categorical palette sit below 3:1 contrast on this app's ledger
 * surface, which triggers the palette's relief rule: a chart using them must
 * ship visible labels or an equivalent table view. Removing this toggle
 * silently breaks that accessibility contract (see palette.ts).
 */
export function ChartCard({
  title,
  description,
  controls,
  legend,
  legendAlign = "start",
  exportColumns,
  exportRows,
  exportParts,
  exportBase,
  children,
}: Props) {
  const [asTable, setAsTable] = useState(false);
  const [exporting, setExporting] = useState(false);
  const captureRef = useRef<HTMLDivElement>(null);
  const headingId = useId();

  async function handlePng() {
    if (!captureRef.current) return;
    setExporting(true);
    try {
      await downloadPng(captureRef.current, exportName(exportBase, [...exportParts], "png"));
    } catch {
      // A failed rasterization must not take the dashboard down with it.
      // Nothing sensitive to report; the user simply sees no download.
    } finally {
      setExporting(false);
    }
  }

  return (
    <Card className="flex h-full flex-col" aria-labelledby={headingId}>
      <CardHeader className="flex flex-row items-start gap-3">
        <div className="min-w-0 flex-1">
          <CardTitle id={headingId}>{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {controls}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={`Actions for ${title}`}>
                <MoreHorizontal aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>{title}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setAsTable((v) => !v)}>
                {asTable ? <BarChart3 aria-hidden="true" /> : <Table2 aria-hidden="true" />}
                {asTable ? "View as chart" : "View as table"}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={handlePng} disabled={exporting || asTable}>
                <ImageIcon aria-hidden="true" />
                Export PNG
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() =>
                  downloadCsv(exportName(exportBase, [...exportParts], "csv"), exportColumns, exportRows)
                }
              >
                <Download aria-hidden="true" />
                Export CSV
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardHeader>

      <CardContent className="flex-1">
        {/* The capture covers the plot AND its legend, but not the card chrome,
            so the exported PNG carries no menu button — and never loses the
            colour key. The legend USED to sit outside this div, which meant
            every exported chart shipped without one: for the volume chart the
            legend is the only thing naming the series, so the PNG was a stack
            of unlabelled bars, exactly what the palette relief rule in the
            docblock above forbids. */}
        <div ref={captureRef} className="bg-card">
          {asTable ? (
            <DataTable columns={exportColumns} rows={exportRows} />
          ) : exportRows.length === 0 ? (
            <EmptyPlot />
          ) : (
            children
          )}

          {legend && legend.length > 1 && !asTable && (
            <ul
              className={cn(
                "mt-3 flex flex-wrap gap-x-4 gap-y-1.5",
                legendAlign === "center" && "justify-center",
              )}
            >
              {legend.map((l) => (
                <li key={l.label} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span
                    aria-hidden="true"
                    className="size-2.5 shrink-0 rounded-[2px]"
                    style={{ background: l.color }}
                  />
                  {l.label}
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function EmptyPlot() {
  return (
    <div className="flex h-[240px] items-center justify-center rounded-ledger border border-dashed border-border text-sm text-muted-foreground">
      No data for this selection yet.
    </div>
  );
}

function DataTable({ columns, rows }: { columns: string[]; rows: Array<Record<string, unknown>> }) {
  if (rows.length === 0) return <EmptyPlot />;
  return (
    <div className="max-h-[280px] overflow-auto">
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((c) => (
              <TableHead key={c}>{c}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r, i) => (
            <TableRow key={i}>
              {columns.map((c) => (
                <TableCell key={c} className="tabular-nums">
                  {r[c] === null || r[c] === undefined ? "—" : String(r[c])}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
