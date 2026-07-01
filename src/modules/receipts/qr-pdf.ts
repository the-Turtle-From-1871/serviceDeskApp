import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { itemQrDataUrl, itemUrl } from "@/modules/items/qr";

type QrItem = {
  id: string;
  make: string;
  model: string;
  serialNumber: string;
  assetTag: string | null;
  homeLocation: string | null;
  currentHolder: { name: string } | null;
};

// A single-page, print-friendly PDF: item identity, a large QR code, and the
// URL it encodes. Letter portrait (612 x 792 pt).
export async function buildItemQrPdf(item: QrItem): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.06, 0.09, 0.16);
  const muted = rgb(0.4, 0.45, 0.5);

  const dataUrl = await itemQrDataUrl(item.id);
  const png = await pdf.embedPng(Buffer.from(dataUrl.split(",")[1], "base64"));

  let y = 740;
  page.drawText("HAND RECEIPT — ITEM", { x: 56, y, size: 12, font: bold, color: muted });
  y -= 34;
  page.drawText(`${item.make} ${item.model}`, { x: 56, y, size: 24, font: bold, color: ink });
  y -= 40;

  const rows: [string, string][] = [
    ["Serial number", item.serialNumber],
    ["Asset tag", item.assetTag ?? "—"],
    ["Home location", item.homeLocation ?? "—"],
    ["Current holder", item.currentHolder?.name ?? "Unassigned"],
  ];
  for (const [k, v] of rows) {
    page.drawText(k, { x: 56, y, size: 11, font: bold, color: muted });
    page.drawText(v, { x: 200, y, size: 12, font, color: ink });
    y -= 22;
  }

  // Centered QR
  const qrSize = 300;
  const qrX = (612 - qrSize) / 2;
  const qrY = 190;
  page.drawImage(png, { x: qrX, y: qrY, width: qrSize, height: qrSize });

  const url = itemUrl(item.id);
  const urlWidth = font.widthOfTextAtSize(url, 10);
  page.drawText(url, { x: (612 - urlWidth) / 2, y: qrY - 26, size: 10, font, color: muted });
  const scan = "Scan to view item details and transfer history";
  const scanWidth = font.widthOfTextAtSize(scan, 11);
  page.drawText(scan, { x: (612 - scanWidth) / 2, y: qrY - 48, size: 11, font, color: ink });

  return pdf.save();
}
