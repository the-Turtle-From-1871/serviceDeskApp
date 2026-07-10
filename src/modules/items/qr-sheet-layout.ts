// Pure layout math for the bulk QR-label sheet. No pdf-lib / qrcode here so it
// can be unit-tested in isolation; the builder consumes these numbers.
//
// pdf-lib uses a bottom-left origin, so all Y values below are measured up from
// the bottom of the page.

export type QrSheetConfig = {
  pageW: number;
  pageH: number;
  margin: number;
  cols: number;
  gutter: number;
  serialGap: number;
  serialFontSize: number;
  rowGap: number;
};

export const QR_SHEET: QrSheetConfig = {
  pageW: 612, // US Letter, points (8.5in)
  pageH: 792, // US Letter, points (11in)
  margin: 18, // 0.25in safe printable margin
  cols: 8, // 8 QR codes across, per the spec
  gutter: 6, // horizontal space removed from the cell to size the (square) QR
  serialGap: 2, // gap between the QR bottom and the serial text
  serialFontSize: 7,
  rowGap: 5, // breathing room below the serial, within the cell
};

export type QrSheetLayout = {
  pageW: number;
  pageH: number;
  margin: number;
  cols: number;
  serialFontSize: number;
  serialGap: number;
  cellW: number;
  qrSize: number;
  cellH: number;
  rows: number;
  perPage: number;
};

export function computeQrSheetLayout(cfg: QrSheetConfig = QR_SHEET): QrSheetLayout {
  const cellW = (cfg.pageW - 2 * cfg.margin) / cfg.cols;
  // A QR code is square, so its height equals its width (the column width).
  const qrSize = cellW - cfg.gutter;
  const cellH = qrSize + cfg.serialGap + cfg.serialFontSize + cfg.rowGap;
  const rows = Math.floor((cfg.pageH - 2 * cfg.margin) / cellH);
  return {
    pageW: cfg.pageW,
    pageH: cfg.pageH,
    margin: cfg.margin,
    cols: cfg.cols,
    serialFontSize: cfg.serialFontSize,
    serialGap: cfg.serialGap,
    cellW,
    qrSize,
    cellH,
    rows,
    perPage: rows * cfg.cols,
  };
}

export type CellPos = {
  qrX: number; // bottom-left X of the QR image
  qrY: number; // bottom-left Y of the QR image
  cellCenterX: number; // for centering the serial under the QR
  serialBaselineY: number; // text baseline for the serial line
};

/** Position of the cell at `indexOnPage` (0..perPage-1), left-to-right then
 *  top-to-bottom, in pdf-lib bottom-left coordinates. */
export function cellPosition(layout: QrSheetLayout, indexOnPage: number): CellPos {
  const col = indexOnPage % layout.cols;
  const row = Math.floor(indexOnPage / layout.cols);
  const cellLeft = layout.margin + col * layout.cellW;
  const cellTopY = layout.pageH - (layout.margin + row * layout.cellH);
  const qrX = cellLeft + (layout.cellW - layout.qrSize) / 2;
  const qrY = cellTopY - layout.qrSize;
  return {
    qrX,
    qrY,
    cellCenterX: cellLeft + layout.cellW / 2,
    serialBaselineY: qrY - layout.serialGap - layout.serialFontSize,
  };
}

/** Fit `text` within `maxWidth`: shrink the font from `startSize` down to
 *  `minSize`, then truncate with an ellipsis if it still overflows. `measure`
 *  reports the rendered width of a string at a given font size. */
export function fitSerialText(
  text: string,
  maxWidth: number,
  measure: (t: string, size: number) => number,
  startSize = 7,
  minSize = 5,
): { text: string; size: number } {
  for (let size = startSize; size >= minSize; size--) {
    if (measure(text, size) <= maxWidth) return { text, size };
  }
  let t = text;
  while (t.length > 1 && measure(t + "…", minSize) > maxWidth) t = t.slice(0, -1);
  return { text: t.length < text.length ? t + "…" : t, size: minSize };
}
