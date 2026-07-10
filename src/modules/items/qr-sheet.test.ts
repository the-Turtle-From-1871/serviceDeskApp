import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import { buildItemsQrSheetPdf } from "./qr-sheet";
import { computeQrSheetLayout, QR_SHEET } from "./qr-sheet-layout";

const items = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `id${i}`, serialNumber: `SN-${i}` }));

describe("buildItemsQrSheetPdf", () => {
  it("produces a valid single-page PDF for a few items", async () => {
    const bytes = await buildItemsQrSheetPdf(items(3), { baseUrl: "https://x" });
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
  });

  it("paginates onto a new page once items exceed perPage", async () => {
    // Small page => tiny perPage, so we only generate a handful of QR codes.
    const layout = computeQrSheetLayout({ ...QR_SHEET, cols: 2, pageW: 200, pageH: 200 });
    const onePage = await buildItemsQrSheetPdf(items(layout.perPage), { layout, baseUrl: "https://x" });
    expect((await PDFDocument.load(onePage)).getPageCount()).toBe(1);
    const twoPages = await buildItemsQrSheetPdf(items(layout.perPage + 1), { layout, baseUrl: "https://x" });
    expect((await PDFDocument.load(twoPages)).getPageCount()).toBe(2);
  });
});
