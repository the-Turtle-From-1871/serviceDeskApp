import { PDFDocument, StandardFonts, rgb, degrees, TextAlignment } from "pdf-lib";
import { DA2062_BASE64 } from "./templates/da2062.base64";
import { formatDateHST } from "@/lib/datetime";

export type ReceiptData = {
  id: string;
  fromUserName: string | null;
  toUserName: string;
  status: string;
  isOverride: boolean;
  signatureImage: string | null;
  initiatedAt: Date;
  signedAt: Date | null;
  item: { make: string; model: string; serialNumber: string; assetTag: string | null };
};

const templateBytes = () => Buffer.from(DA2062_BASE64, "base64");

function fmt(d: Date | null): string {
  return formatDateHST(d);
}

function transferType(t: ReceiptData): string {
  if (t.isOverride) return "Administrative override";
  if (!t.fromUserName) return "Initial issue";
  return "Signed transfer";
}

// Fills the DA Form 2062 (Hand Receipt) for a single-item custody transfer and
// appends a signed custody record page (drawn signature + dates), so the
// official two-page form is preserved and the signature evidence travels with it.
export async function buildHandReceiptPdf(t: ReceiptData): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(templateBytes());
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const form = pdf.getForm();
  const set = (
    name: string,
    value: string,
    opts: { multiline?: boolean; size?: number; center?: boolean } = {}
  ) => {
    try {
      const field = form.getTextField(name);
      if (opts.multiline) field.enableMultiline();
      if (opts.center) field.setAlignment(TextAlignment.Center);
      field.setFontSize(opts.size ?? 10); // avoid pdf-lib auto-sizing short values huge
      field.setText(value);
    } catch {
      /* field not present in this template revision — ignore */
    }
  };

  // Header. FROM/TO take name, rank and organization; we only store a name, so
  // the name is used. END ITEM and PUBLICATION blocks are intentionally left
  // blank — per DA 2062 guidance those are only for component (sub-)hand
  // receipts that list parts drawn from a specific end item / TM.
  set("FROM", t.fromUserName ?? "Initial issue", { size: 11 });
  set("TO", t.toUserName, { size: 11 });
  set("HAND RECEIPT IDENTIFIER", `HR-${t.id.slice(0, 8).toUpperCase()}`, { size: 11 });

  // Item line 1. Columns: a=ITEM NO, b=MATERIAL NUMBER (NSN / local material
  // id), c=ITEM DESCRIPTION (nomenclature + serial), UI=Unit of Issue,
  // QTY=Qty Authorized, A.*=Qty on hand. ARC/CIIC are skipped: in this template
  // those fields share one widget across two rows, so filling them would bleed
  // onto the empty row below — the accountability data is on the record page.
  set("ITEM NO aRow1", "1", { size: 9, center: true });
  set("MATERIAL NUMBER bRow1", t.item.assetTag ?? "", { size: 9 });
  set("ITEM DESCRIPTION cRow1", `${t.item.make} ${t.item.model}\nSER NO: ${t.item.serialNumber}`, { multiline: true, size: 9 });
  set("UI.0", "EA", { size: 9, center: true });
  set("QTY.0", "1", { size: 9, center: true });
  // Column-A quantity, recipient signature, date, and anti-tamper guard bars are
  // drawn manually after flatten (below) for exact centering/rotation.

  form.updateFieldAppearances(helv);
  form.flatten();

  // --- Column A: quantity (top), then the recipient's signature and date read
  // vertically up the column (DA 2062 practice), then black "guard" bars over
  // the empty cells so no rows can be added before or after the signed marks.
  const page1 = pdf.getPage(0);
  const black = rgb(0, 0, 0);
  const colLeft = 621;      // column A inner-left (cell borders at 620/645)
  const colWidth = 23;
  const colCenter = 632;    // horizontal centre of column A
  const rowTopY = 486;      // bottom edge of the row-1 quantity cell
  const tableBottomY = 58;  // bottom of the 19-row item table
  const dateStr = fmt(t.signedAt);

  // Quantity "1", centered at the top of column A.
  page1.drawText("1", { x: colCenter - helv.widthOfTextAtSize("1", 9) / 2, y: 492, size: 9, font: helv });

  // Signature (vertical, reads up) with the date after it (further up the column).
  const sigBottom = 350;
  let blockTop = sigBottom;
  let drewImage = false;
  if (t.signatureImage && t.signatureImage.startsWith("data:image/png;base64,")) {
    try {
      const sig = await pdf.embedPng(Buffer.from(t.signatureImage.split(",")[1], "base64"));
      const barH = 22; // horizontal extent inside the ~25px column
      const barW = Math.min(barH * (sig.width / sig.height), 72); // vertical extent
      page1.drawImage(sig, { x: 642, y: sigBottom, width: barW, height: barH, rotate: degrees(90) });
      const dateY = sigBottom + barW + 10;
      page1.drawText(dateStr, { x: colCenter + 4, y: dateY, size: 9, font: helv, rotate: degrees(90) });
      blockTop = dateY + helv.widthOfTextAtSize(dateStr, 9);
      drewImage = true;
    } catch {
      /* fall through to text fallback below */
    }
  }
  if (!drewImage) {
    const label = `${t.toUserName}   ${dateStr}`;
    page1.drawText(label, { x: colCenter + 4, y: sigBottom, size: 9, font: helv, rotate: degrees(90) });
    blockTop = sigBottom + helv.widthOfTextAtSize(label, 9);
  }

  // Guard bars: black out the empty column below the signed block and any gap
  // above it (up to the quantity cell), so entries can't be inserted later.
  page1.drawRectangle({ x: colLeft, y: tableBottomY, width: colWidth, height: sigBottom - 4 - tableBottomY, color: black });
  if (rowTopY - (blockTop + 2) > 1) {
    page1.drawRectangle({ x: colLeft, y: blockTop + 2, width: colWidth, height: rowTopY - (blockTop + 2), color: black });
  }

  // Appended custody record page.
  const page = pdf.addPage([612, 792]);
  const ink = rgb(0.06, 0.09, 0.16);
  const muted = rgb(0.4, 0.45, 0.5);
  let y = 730;
  page.drawText("CUSTODY TRANSFER RECORD", { x: 56, y, size: 16, font: bold, color: ink });
  y -= 12;
  page.drawText(`Hand receipt HR-${t.id.slice(0, 8).toUpperCase()}`, { x: 56, y: y - 6, size: 10, font: helv, color: muted });
  y -= 40;

  const rows: [string, string][] = [
    ["Item", `${t.item.make} ${t.item.model}`],
    ["Serial number", t.item.serialNumber],
    ["Material / asset tag", t.item.assetTag ?? "—"],
    ["Quantity / U/I", "1 EA"],
    ["ARC", "N (nonexpendable)"],
    ["From", t.fromUserName ?? "Initial issue"],
    ["To", t.toUserName],
    ["Type", transferType(t)],
    ["Initiated", fmt(t.initiatedAt)],
    ["Signed / effective", fmt(t.signedAt)],
    ["Status", t.status],
  ];
  for (const [k, v] of rows) {
    page.drawText(k, { x: 56, y, size: 11, font: bold, color: muted });
    page.drawText(v, { x: 220, y, size: 12, font: helv, color: ink });
    y -= 24;
  }

  y -= 20;
  page.drawText("Recipient signature", { x: 56, y, size: 11, font: bold, color: muted });
  y -= 14;
  if (t.signatureImage && t.signatureImage.startsWith("data:image/png;base64,")) {
    try {
      const png = await pdf.embedPng(Buffer.from(t.signatureImage.split(",")[1], "base64"));
      const w = 260;
      const h = (png.height / png.width) * w;
      page.drawImage(png, { x: 56, y: y - h, width: w, height: Math.min(h, 110) });
      y -= Math.min(h, 110);
    } catch {
      page.drawText("(signature on file)", { x: 56, y: y - 12, size: 11, font: helv, color: muted });
      y -= 24;
    }
  } else {
    page.drawText(t.isOverride ? "(administrative override — no signature)" : "(no signature captured)", {
      x: 56, y: y - 12, size: 11, font: helv, color: muted,
    });
    y -= 24;
  }

  page.drawLine({ start: { x: 56, y: y - 10 }, end: { x: 320, y: y - 10 }, thickness: 0.5, color: muted });
  page.drawText(`${t.toUserName} · ${fmt(t.signedAt)}`, { x: 56, y: y - 24, size: 10, font: helv, color: muted });

  return pdf.save();
}
