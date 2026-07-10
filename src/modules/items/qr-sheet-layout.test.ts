import { describe, it, expect } from "vitest";
import { computeQrSheetLayout, cellPosition, fitSerialText, QR_SHEET } from "./qr-sheet-layout";

describe("computeQrSheetLayout", () => {
  it("lays out 8 columns on US Letter with a serial row under each QR", () => {
    const L = computeQrSheetLayout();
    expect(L.cols).toBe(8);
    expect(L.pageW).toBe(612);
    expect(L.pageH).toBe(792);
    // usable width 576 / 8 columns = 72pt cells; QR is column width minus the gutter.
    expect(L.cellW).toBe(72);
    expect(L.qrSize).toBe(66);
    // cell = qr(66) + serialGap(2) + serialFont(7) + rowGap(5) = 80
    expect(L.cellH).toBe(80);
    // usable height 756 / 80 = 9 full rows -> 72 per page
    expect(L.rows).toBe(9);
    expect(L.perPage).toBe(72);
  });

  it("packs more rows per page when the QR is smaller (more columns)", () => {
    const L = computeQrSheetLayout({ ...QR_SHEET, cols: 12 });
    expect(L.cols).toBe(12);
    expect(L.perPage).toBeGreaterThan(computeQrSheetLayout().perPage);
  });
});

describe("cellPosition", () => {
  const L = computeQrSheetLayout();

  it("places the first cell (top-left) with a bottom-left origin", () => {
    const p = cellPosition(L, 0);
    // cell top y = 792 - margin(18) = 774; QR drawn from its bottom-left
    expect(p.qrY).toBe(708); // 774 - 66
    expect(p.qrX).toBe(21); // 18 + (72-66)/2
    expect(p.cellCenterX).toBe(54); // 18 + 72/2
    expect(p.serialBaselineY).toBe(699); // 708 - gap(2) - font(7)
  });

  it("advances left-to-right then top-to-bottom", () => {
    const rightOfFirst = cellPosition(L, 1);
    expect(rightOfFirst.qrX).toBe(93); // one cell (72) right of 21
    expect(rightOfFirst.qrY).toBe(708); // same row

    const nextRow = cellPosition(L, L.cols); // index 8 -> row 1, col 0
    expect(nextRow.qrX).toBe(21); // back to first column
    expect(nextRow.qrY).toBe(628); // 708 - cellH(80)
  });

  it("keeps the last column inside the right margin", () => {
    const last = cellPosition(L, 7);
    expect(last.qrX + L.qrSize).toBeLessThanOrEqual(L.pageW - L.margin);
  });
});

describe("fitSerialText", () => {
  // fake measure: width = chars * size * 0.5
  const measure = (t: string, size: number) => t.length * size * 0.5;

  it("uses the start size when it already fits", () => {
    expect(fitSerialText("SN-1", 100, measure, 7, 5)).toEqual({ text: "SN-1", size: 7 });
  });

  it("shrinks the font to fit before truncating", () => {
    // "ABCDEFGH" (8 chars): at 7pt = 28 wide, at 6pt = 24, at 5pt = 20
    const r = fitSerialText("ABCDEFGH", 25, measure, 7, 5);
    expect(r.size).toBe(6);
    expect(r.text).toBe("ABCDEFGH");
  });

  it("truncates with an ellipsis when even the min size overflows", () => {
    const r = fitSerialText("SUPER-LONG-SERIAL-NUMBER", 20, measure, 7, 5);
    expect(r.size).toBe(5);
    expect(r.text.endsWith("…")).toBe(true);
    expect(measure(r.text, 5)).toBeLessThanOrEqual(20);
  });
});
