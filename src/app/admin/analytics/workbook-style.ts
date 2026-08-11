import "server-only"; // shared by the xlsx builders, which must never reach the client
import type { Row } from "write-excel-file/node";

/* ============================================================
   Shared presentation for the dashboard's .xlsx exports.

   TWO builders use this — the dormant-device chase list (stale-workbook.ts)
   and the dropped-off-network list (dropped-workbook.ts) — and they are sheets
   a technician reads side by side. A second copy of the header treatment is a
   second answer to "what does one of our exports look like", and they drift.

   THE PROPERTY IS `textColor`, NOT `color`. write-excel-file renamed it in v3
   and SILENTLY DISCARDS an unknown key: `getCellStyleProperties` destructures
   only the names it knows, and TypeScript does not complain because an excess
   key survives the `Cell` union. Writing `color` type-checks, builds, produces
   a valid file, and leaves the cell on Excel's default `theme="1"` — black. That
   shipped once, on 2026-08-11: every sheet exported that day had black column
   headings on the near-black fill below, at about 1.5:1. Check a new style
   property against `write-excel-file/types/CellStyleProperties.d.ts`, and assert
   on the RESOLVED font or fill in the produced bytes rather than on what was
   passed in — the builders' tests do.
   ============================================================ */

/** The ledger's ink. Dark, so the header needs light text on it. */
export const HEADER_FILL = "#1F2933";
export const HEADER_TEXT = "#FFFFFF";

/** The bold, reversed-out header row for a sheet's column names. */
export function headerRow(columns: readonly string[]): Row {
  return columns.map((value) => ({
    value,
    fontWeight: "bold" as const,
    textColor: HEADER_TEXT,
    backgroundColor: HEADER_FILL,
  }));
}

/**
 * Column widths, in characters.
 *
 * Excel's default (~8.4) truncates a device name and an ISO date alike, and a
 * sheet someone has to widen by hand before they can read it is a sheet that
 * gets closed. Keyed by header rather than by position so a reordered or
 * renamed column cannot silently take the wrong width.
 */
export const DEFAULT_COLUMN_WIDTH = 16;

export function columnWidths(
  columns: readonly string[],
  widths: Record<string, number>,
): { width: number }[] {
  return columns.map((c) => ({ width: widths[c] ?? DEFAULT_COLUMN_WIDTH }));
}

/** Widths shared by both sheets — they carry the same identity columns. */
export const COMMON_WIDTHS: Record<string, number> = {
  Serial: 18,
  "Device name": 22,
  Make: 14,
  Model: 18,
  Category: 14,
  "Home unit": 30,
  UIC: 10,
  Holder: 24,
  Position: 16,
  "Storage location": 18,
  "Last logon user": 26,
  Compliance: 14,
  Readiness: 16,
};
