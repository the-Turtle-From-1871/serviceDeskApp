"use client";

import { useState, useTransition } from "react";
import { Download } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { exportStaleDevicesAction } from "@/app/admin/actions/analytics";
import { downloadCsv, exportName } from "./export";
import {
  STALE_MIN_DAYS,
  STALE_MAX_DAYS,
  STALE_EXPORT_MAX,
  scopeLabel,
  type ItemScope,
} from "./analytics.types";

/**
 * The stale-device chase list, as a count and a download.
 *
 * NOT a ChartCard: there is no chart. A list of individual devices is a
 * spreadsheet, not a plot — bucketing it would hide the one thing it is for,
 * which is the serial numbers.
 *
 * The COUNT is server-rendered from the same predicate the export uses, so the
 * number on screen and the rows in the file cannot disagree. The ROWS are
 * fetched on click rather than shipped with the page: they are only ever wanted
 * when someone actually exports, and sending a few hundred rows of holder names
 * into the browser on every dashboard load would be exactly the "don't ship the
 * table to a Client Component" rule being broken for a button nobody pressed.
 */
export function StaleDevicesCard({ count, scope }: { count: number; scope: ItemScope }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  function handleExport() {
    setMessage(null);
    startTransition(async () => {
      const res = await exportStaleDevicesAction(scope);
      if ("error" in res) {
        setMessage(res.error);
        return;
      }
      if (res.rows.length === 0) {
        // Reachable without anything being wrong: an import can land between the
        // page render and the click. Say so rather than handing over a file with
        // nothing but headers in it.
        setMessage("No devices are in that window any more. Reload for the current count.");
        return;
      }
      downloadCsv(
        // The filename carries the window and the active unit, like every other
        // export here, so a sheet mailed on is self-describing.
        exportName(
          "stale-devices",
          [`${STALE_MIN_DAYS}-${STALE_MAX_DAYS}d`, scope.unit, scope.uic],
          "csv",
        ),
        res.columns,
        res.rows,
      );
      setMessage(
        res.truncated
          ? `Exported the first ${STALE_EXPORT_MAX.toLocaleString()} devices — there are more. Filter by unit to cover the rest.`
          : `Exported ${res.rows.length.toLocaleString()} device${res.rows.length === 1 ? "" : "s"}.`,
      );
    });
  }

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-3 p-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">
            {count.toLocaleString()} stale device{count === 1 ? "" : "s"}
          </p>
          <p className="text-xs text-muted-foreground">
            Last seen by MDM {STALE_MIN_DAYS}–{STALE_MAX_DAYS} days ago · {scopeLabel(scope)}.
            Devices unseen for over {STALE_MAX_DAYS} days, devices MDM has never seen, and devices
            out on an open hand receipt are not counted.
          </p>
          {/* aria-live so the outcome reaches a screen reader: the visible
              evidence of success is a file landing outside the page. */}
          <p className="mt-1 text-xs text-muted-foreground" role="status" aria-live="polite">
            {message}
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          onClick={handleExport}
          // Nothing to export is a real state on a filtered view, and an empty
          // sheet is a worse answer than a disabled button.
          disabled={pending || count === 0}
        >
          <Download aria-hidden="true" />
          {pending ? "Building…" : "Export CSV"}
        </Button>
      </CardContent>
    </Card>
  );
}
