import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import QRCode from "qrcode";
import { itemUrl } from "@/modules/items/qr";
import { computeQrSheetLayout, cellPosition, fitSerialText, type QrSheetLayout } from "./qr-sheet-layout";

export type QrSheetItem = { id: string; serialNumber: string };

// Builds a multi-page, 8-across sheet of scannable QR labels (each encoding the
// item URL) with the serial number centered beneath each code. Pure builder —
// the caller loads the items and serves the bytes.
export async function buildItemsQrSheetPdf(
  items: QrSheetItem[],
  opts: { layout?: QrSheetLayout; baseUrl?: string } = {},
): Promise<Uint8Array> {
  const layout = opts.layout ?? computeQrSheetLayout();
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const ink = rgb(0.06, 0.09, 0.16);

  let page = pdf.addPage([layout.pageW, layout.pageH]);
  for (let i = 0; i < items.length; i++) {
    const indexOnPage = i % layout.perPage;
    if (i > 0 && indexOnPage === 0) page = pdf.addPage([layout.pageW, layout.pageH]);

    const item = items[i];
    const pos = cellPosition(layout, indexOnPage);

    const qrBuf = await QRCode.toBuffer(itemUrl(item.id, opts.baseUrl), { margin: 1, width: 320 });
    const png = await pdf.embedPng(qrBuf);
    page.drawImage(png, { x: pos.qrX, y: pos.qrY, width: layout.qrSize, height: layout.qrSize });

    const fit = fitSerialText(
      item.serialNumber,
      layout.qrSize,
      (t, s) => font.widthOfTextAtSize(t, s),
      layout.serialFontSize,
    );
    const textWidth = font.widthOfTextAtSize(fit.text, fit.size);
    page.drawText(fit.text, {
      x: pos.cellCenterX - textWidth / 2,
      y: pos.serialBaselineY,
      size: fit.size,
      font,
      color: ink,
    });
  }
  return pdf.save();
}
