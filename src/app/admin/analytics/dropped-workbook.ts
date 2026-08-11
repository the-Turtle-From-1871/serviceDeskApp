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

   What it has instead is the `MDM record` column, and that column is the whole
   reason the sheet is legible. Measured the day it was built: 164 devices, of
   which **12 had been in MDM and dropped out** and **152 were never enrolled at
   all**. Only the first group has "dropped off the network" happen to it; the
   rest were never on it as far as MDM is concerned. Sorting puts the 12 at the
   top (see `listDroppedDevices`) so they are not buried, and the header note
   below says the split in words for whoever opens the file cold.
   ============================================================ */

/** Widths for the columns this sheet has beyond the shared identity block. */
const COLUMN_WIDTH: Record<string, number> = {
  ...COMMON_WIDTHS,
  "MDM record": 16,
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

  const droppedOut = rows.filter((r) => r["MDM record"] === "Dropped out").length;
  const neverEnrolled = rows.length - droppedOut;

  // Below the data, like the dormant sheet's legend, and for the same reason:
  // above it would push the header off row 1 and break "freeze the top row" and
  // every select-the-header-and-filter habit.
  const notes: SheetData = [
    [],
    [{ value: "What this sheet is", fontWeight: "bold" }],
    [
      {
        value:
          `Devices with NO MDM sync time at all · ${scopeLabel(scope)}. These cannot appear on the ` +
          `dormant-device list at any age, because there is no date to measure — this is the only ` +
          `place they are visible. Devices with no device name are not listed.`,
      },
    ],
    [
      {
        value:
          `${droppedOut.toLocaleString()} dropped out — MDM used to report these and no longer does; ` +
          `check whether they were unenrolled, wiped or reassigned. ` +
          `${neverEnrolled.toLocaleString()} never enrolled — MDM has no record of these at all, ` +
          `so the question is whether they should be enrolled.`,
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
