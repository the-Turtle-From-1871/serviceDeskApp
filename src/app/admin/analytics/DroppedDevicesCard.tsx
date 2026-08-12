"use client";

import { useState, useTransition } from "react";
import { Download } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { exportDroppedDevicesAction } from "@/app/admin/actions/analytics";
import { downloadBase64, exportName, XLSX_MIME } from "./export";
import { DEVICE_EXPORT_MAX, scopeLabel, type ItemScope } from "./analytics.types";

/**
 * Devices MDM cannot see at all, as a count and a download.
 *
 * THE SIBLING of StaleDevicesCard, and the pair is deliberate. That card counts
 * devices MDM saw 30-90 days ago; this one counts devices with NO sync time —
 * which the window can never reach, because there is no date to measure. Before
 * this existed they were simply invisible: excluded from the dormant list as
 * "we cannot say when", and surfaced nowhere else.
 *
 * IT IS TWO POPULATIONS AND THE SHEET SAYS SO. Measured when it was built: of
 * 164 devices, 12 had been in MDM and dropped out; 152 were never enrolled. The
 * name describes the first group. The `MDM record` column and the sort order
 * are what stop the 12 being buried under the 152 — see dropped-workbook.ts.
 *
 * No colour banding here, unlike its sibling: every device on this list has no
 * sync time, so there is no age to band and shading would invent a severity the
 * data does not carry.
 */
export function DroppedDevicesCard({ count, scope }: { count: number; scope: ItemScope }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  function handleExport() {
    setMessage(null);
    startTransition(async () => {
      // Same reasoning as the dormant card: React rethrows a rejected async
      // transition to the nearest error boundary, so a failure to REACH the
      // action would unmount the dashboard because a download failed.
      let res: Awaited<ReturnType<typeof exportDroppedDevicesAction>>;
      try {
        res = await exportDroppedDevicesAction(scope);
      } catch {
        setMessage("Could not reach the server. Check your connection and try again.");
        return;
      }
      if ("error" in res) {
        setMessage(res.error);
        return;
      }
      if (res.rowCount === 0) {
        setMessage("No devices are in that state any more. Reload for the current count.");
        return;
      }
      downloadBase64(
        exportName("dropped-off-network", [scope.unit, scope.uic], "xlsx"),
        res.base64,
        XLSX_MIME,
      );
      setMessage(
        res.truncated
          ? `Exported the first ${DEVICE_EXPORT_MAX.toLocaleString()} devices — there are more. Filter by unit to cover the rest.`
          : `Exported ${res.rowCount.toLocaleString()} device${res.rowCount === 1 ? "" : "s"}.`,
      );
    });
  }

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-3 p-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">
            {count.toLocaleString()} device{count === 1 ? "" : "s"} dropped off the network
          </p>
          <p className="text-xs text-muted-foreground">
            The MDM export has stopped listing these, or has never reported a sync time for them ·{" "}
            {scopeLabel(scope)}. Neither can appear on the list above at any age, because there is no
            sync date to measure — this is the only place they show up. Loaner-pool stock and devices
            with no device name are not listed.
          </p>
          <p className="text-xs text-muted-foreground">
            The export marks each one <strong>Missing from import</strong> (the latest export did not
            list it — the sheet gives the date it first went missing, so check whether it was
            unenrolled, wiped or reassigned), <strong>Dropped out</strong> (MDM knows it but has
            never reported a sync time) or <strong>Never enrolled</strong> (no MDM record at all, so
            the question is whether it should be enrolled). The dated ones are listed first,
            longest-gone first — and a device that reappears in a later export drops off this list
            on its own.
          </p>
          <p className="mt-1 text-xs text-muted-foreground" role="status" aria-live="polite">
            {message}
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          onClick={handleExport}
          disabled={pending || count === 0}
        >
          <Download aria-hidden="true" />
          {pending ? "Building…" : "Export Excel"}
        </Button>
      </CardContent>
    </Card>
  );
}
