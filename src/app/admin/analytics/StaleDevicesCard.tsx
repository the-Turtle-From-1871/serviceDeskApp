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
 * The dormant-device chase list, as a count and a download.
 *
 * WHAT "DORMANT" MEANS HERE: NO MDM CHECK-IN for 30-90 days (`Item.lastSyncAt`,
 * the parsed `lastSyncDateTime`). It is NOT "nobody has signed in" — that is
 * `lastLogonAt`, a different column answering a different question, and the two
 * routinely disagree (a device powered on in a cage syncs nightly with nobody
 * signing in for months). This card shipped measuring SIGN-IN while describing
 * itself as MDM silence; the wording was fixed first and the column followed on
 * 2026-08-11, so the two now agree on the question the desk actually works.
 *
 * KNOWN AND EXPECTED: the count is low today. `lastSyncAt` only exists from the
 * import that filled it, so a device the fleet export has not covered since
 * 2026-08-10 has no sync instant and is not counted — same treatment as any
 * other "we cannot say" row. It fills in as imports run.
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
      // The action converts an AuthError and a failed query into `{ error }`,
      // but it cannot convert a failure to REACH it: offline, a platform 5xx,
      // or a stale action id after a redeploy all reject the promise. React
      // rethrows a rejected async transition to the nearest error boundary, so
      // without this the whole dashboard unmounts because a download failed —
      // the exact "a 500 from a download button reads as 'the export is
      // broken'" outcome the AuthError branch exists to avoid.
      let res: Awaited<ReturnType<typeof exportStaleDevicesAction>>;
      try {
        res = await exportStaleDevicesAction(scope);
      } catch {
        setMessage("Could not reach the server. Check your connection and try again.");
        return;
      }
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
            {count.toLocaleString()} device{count === 1 ? "" : "s"} MDM has not seen recently
          </p>
          <p className="text-xs text-muted-foreground">
            MDM has not checked in for {STALE_MIN_DAYS}–{STALE_MAX_DAYS} days · {scopeLabel(scope)}.
            This is the last <em>MDM sync</em>, not the last user sign-in — a device can sit unused
            and still sync nightly. Devices unseen for over {STALE_MAX_DAYS} days, devices with no
            sync time recorded yet, and devices out on an open hand receipt are not counted.
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
