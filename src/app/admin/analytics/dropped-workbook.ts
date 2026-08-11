import "server-only"; // pulls in the xlsx writer — never bundle it to the client
import writeXlsxFile from "write-excel-file/node";
import type { SheetData, Row, CellObject } from "write-excel-file/node";
import {
  DROPPED_DEVICE_COLUMNS,
  scopeLabel,
  type ItemScope,
  type DroppedDeviceRow,
} from "./analytics.types";
import { headerRow, columnWidths, COMMON_WIDTHS } from "./workbook-style";

/* ============================================================
   The dropped-off-network export.

   The dormant sheet's SIBLING, and deliberately a plainer one. That sheet
   colours every row because it has an axis to colour — days since the last
   sync, plus compliance. This list has neither: every device on it has NO sync
   time at all, so there is no age to band and nothing to shade. Colouring it
   anyway would invent a severity the data does not carry.

   What it has instead is the `MDM record` column and its `Dropped off` date,
   and together they are the whole reason the sheet is legible. Three states:
   **Missing from import** (the newest fleet census did not list the device —
   the strongest signal, and the only one with a date), **Dropped out** (MDM
   knows it but has never reported a sync time) and **Never enrolled** (no MDM
   record of any kind). Measured the day the list was built, before the census
   rule existed: 164 devices, 12 dropped out and 152 never enrolled. Sorting
   puts the dated ones first, longest-gone first (see `listDroppedDevices`), so
   the actionable handful is never buried under the never-enrolled backlog, and
   the note below says the split in words for whoever opens the file cold.
   ============================================================ */

/** Widths for the columns this sheet has beyond the shared identity block. */
const COLUMN_WIDTH: Record<string, number> = {
  ...COMMON_WIDTHS,
  "MDM record": 20,
  "Dropped off": 14,
  "Last logon date": 16,
};

export async function buildDroppedDevicesWorkbook(
  rows: DroppedDeviceRow[],
  scope: ItemScope,
  truncated: boolean,
): Promise<Buffer> {
  const header: Row = headerRow(DROPPED_DEVICE_COLUMNS);

  const body: SheetData = rows.map((row) =>
    DROPPED_DEVICE_COLUMNS.map((column) => ({
      value: String(row[column] ?? ""),
      type: String,
    })),
  );

  const missing = rows.filter((r) => r["MDM record"] === "Missing from import").length;
  const droppedOut = rows.filter((r) => r["MDM record"] === "Dropped out").length;
  const neverEnrolled = rows.length - missing - droppedOut;

  // Below the data, like the dormant sheet's legend, and for the same reason:
  // above it would push the header off row 1 and break "freeze the top row" and
  // every select-the-header-and-filter habit.
  const notes: SheetData = [
    [],
    [{ value: "What this sheet is", fontWeight: "bold" }],
    [
      {
        value:
          `Devices the MDM export has stopped listing, or has never reported a sync time for · ` +
          `${scopeLabel(scope)}. Neither can appear on the dormant-device list at any age, because ` +
          `there is no sync date to measure — this is the only place they are visible. Devices with ` +
          `no device name are not listed.`,
      },
    ],
    [
      {
        value:
          `${missing.toLocaleString()} missing from import — the latest MDM export did not list these ` +
          `at all, and the Dropped off column says which export first left them out. ` +
          `${droppedOut.toLocaleString()} dropped out — MDM knows these but has never reported a sync ` +
          `time for them. ` +
          `${neverEnrolled.toLocaleString()} never enrolled — MDM has no record of these at all, so the ` +
          `question is whether they should be enrolled.`,
      },
    ],
    ...(truncated
      ? [[{ value: `NOTE: this sheet was capped at ${rows.length.toLocaleString()} devices — there are more. Filter by unit to cover the rest.`, fontWeight: "bold" } satisfies CellObject]]
      : []),
  ];

  return writeXlsxFile([header, ...body, ...notes], {
    sheet: "Dropped off network",
    columns: columnWidths(DROPPED_DEVICE_COLUMNS, COLUMN_WIDTH),
    stickyRowsCount: 1,
  }).toBuffer();
}
