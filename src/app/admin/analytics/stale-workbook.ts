import "server-only"; // pulls in the xlsx writer — never bundle it to the client
import writeXlsxFile from "write-excel-file/node";
// The writer's OWN row/cell types, not a hand-rolled shape. `writeXlsxFile` is
// overloaded — raw rows vs. an array of objects with a column schema — and a
// locally-declared cell type resolves to the objects overload, which then
// demands a `cell` renderer per column. Using SheetData/Row/Cell picks the raw
// form, which is the one this builds.
import type { SheetData, Row, CellObject } from "write-excel-file/node";
import {
  STALE_DEVICE_COLUMNS,
  STALE_MIN_DAYS,
  STALE_MAX_DAYS,
  scopeLabel,
  type ItemScope,
  type StaleDeviceRow,
} from "./analytics.types";
import { headerRow, columnWidths, COMMON_WIDTHS } from "./workbook-style";
import {
  SEVERITY_FILL,
  severityLabel,
  staleSeverity,
  type StaleSeverity,
} from "./stale-severity";

/* ============================================================
   The dormant-device export, as a colour-coded .xlsx.

   WHY NOT CSV. This sheet used to go through `downloadCsv`, the one CSV writer
   the whole dashboard shares. CSV carries no formatting at all, so the moment
   the rows needed colour it had to become a real workbook — this is the ONLY
   export here that does. Every other chart still writes CSV through that shared
   writer, and should: a second format is only worth its weight where the format
   itself carries meaning, which here is the row colour.

   WHY THE FILE IS BUILT ON THE SERVER. The CSV path deliberately built rows
   server-side and wrote the file in the browser, to keep one writer. An xlsx
   writer in the browser bundle would be paid for by every dashboard load
   whether or not anyone exports; built here it costs nothing until the button
   is pressed. The bytes travel back through the existing Server Action as
   base64 rather than a new route, which keeps the action's capability re-check,
   its "you no longer have access" message and its truncation notice — a
   download route would have to answer a revoked grant with a bare 403 in a new
   tab.

   FORMULA INJECTION IS NOT AN ISSUE HERE, and that is a property of the format
   rather than an oversight. Device name, Holder and Last logon user arrive
   verbatim from the MDM import, so a value like `=HYPERLINK("http://evil/")`
   really can be in this data — in CSV that becomes a live formula on open,
   which is why `export.ts` prefixes an apostrophe. A string written to xlsx is
   stored as a string cell; only an explicit formula cell is evaluated, and this
   builder never writes one. `stale-workbook.test.ts` pins that by round-tripping
   such a value.
   ============================================================ */

/* Header treatment and column widths are SHARED with the dropped-off-network
   sheet — see workbook-style.ts, which also records why the text colour
   property is `textColor` and not `color`. */

/** Widths for the two columns only this sheet has. */
const COLUMN_WIDTH: Record<string, number> = {
  ...COMMON_WIDTHS,
  "Last sync date": 14,
  "Days since sync": 15,
};

/**
 * Severity for one already-built export row.
 *
 * Reads the SAME two cells the reader sees — "Days since sync" and
 * "Compliance" — rather than taking a second pass over the database row. That
 * is deliberate: the colour and the numbers in the sheet cannot then disagree
 * about a device, which is the one failure a coloured export must not have.
 */
function severityOf(row: StaleDeviceRow): StaleSeverity {
  const days = Number(row["Days since sync"]);
  return staleSeverity(days, String(row.Compliance ?? ""));
}

/**
 * Build the workbook.
 *
 * Rows arrive already ordered stalest-first and already capped by
 * `listStaleDevices`; this adds presentation and nothing else — it must never
 * filter, because the count on the card is computed from the same predicate and
 * a builder that dropped a row would make the two disagree.
 */
export async function buildStaleDevicesWorkbook(
  rows: StaleDeviceRow[],
  scope: ItemScope,
  truncated: boolean,
): Promise<Buffer> {
  const header: Row = headerRow(STALE_DEVICE_COLUMNS);

  const body: SheetData = rows.map((row) => {
    const fill = SEVERITY_FILL[severityOf(row)];
    return STALE_DEVICE_COLUMNS.map((column) => {
      const raw = row[column];
      // "Days since sync" is the one numeric column. Written as a real number
      // so the sheet can sort and filter it — the whole reason the export
      // carries a derived day count next to the ISO date.
      const numeric = column === "Days since sync";
      return {
        value: numeric ? Number(raw) : String(raw ?? ""),
        type: numeric ? Number : String,
        backgroundColor: fill,
        align: numeric ? ("right" as const) : undefined,
      };
    });
  });

  // The legend goes BELOW the data, after a blank row.
  //
  // Above it would push the header off the first line, which breaks Excel's
  // "freeze the top row" and every "select the header and filter" habit — and
  // this sheet's whole job is to be sorted and filtered. Below, it is still on
  // the page when the file is mailed on to someone who never saw the dashboard,
  // which is the case that needs it: a bare wall of coloured rows explains
  // nothing on its own.
  const legend: SheetData = [
    [],
    [{ value: "What the colours mean", fontWeight: "bold" }],
    ...(["noncompliant", "older", "recent"] as const).map((severity) => [
      { value: "", backgroundColor: SEVERITY_FILL[severity] },
      { value: severityLabel(severity) },
    ]),
    [],
    [
      {
        value:
          `Devices MDM has not checked in with for ${STALE_MIN_DAYS}–${STALE_MAX_DAYS} days · ${scopeLabel(scope)}. ` +
          `This is the last MDM sync, not the last user sign-in. Devices unseen for over ${STALE_MAX_DAYS} days, ` +
          `devices with no sync time recorded, and devices out on an open hand receipt are not listed.`,
      },
    ],
    // Said in the FILE, not only in the toast that fired when it downloaded: a
    // truncated property-book extract that does not say so is a confident wrong
    // answer about which devices need chasing, and the file outlives the toast.
    ...(truncated
      ? [[{ value: `NOTE: this sheet was capped at ${rows.length.toLocaleString()} devices — there are more. Filter by unit to cover the rest.`, fontWeight: "bold" } satisfies CellObject]]
      : []),
  ];

  return writeXlsxFile([header, ...body, ...legend], {
    sheet: "Dormant devices",
    columns: columnWidths(STALE_DEVICE_COLUMNS, COLUMN_WIDTH),
    // Freeze the header so the columns stay named while someone scrolls 86 rows
    // — or 5,000.
    stickyRowsCount: 1,
  }).toBuffer();
}
