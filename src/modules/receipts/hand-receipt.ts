import { PDFDocument, StandardFonts, rgb, degrees, TextAlignment } from "pdf-lib";
import QRCode from "qrcode";
import { DA2062_BASE64 } from "./templates/da2062.base64";
import { formatDateHST } from "@/lib/datetime";

export type ReceiptParty = {
  isDcsim: boolean;
  name: string;
  rank: string | null;
  unit: string | null;
  contact: string | null;
  email: string | null;
};

export type ReceiptData = {
  receiptNumber: string;
  status: string;
  createdAt: Date;
  receiptUrl: string;
  receiverSignature: string; // "" or data:image/png;base64,…
  item: { make: string; model: string; serialNumber: string; homeUnit: string | null };
  sender: ReceiptParty;
  receiver: ReceiptParty;
};

const templateBytes = () => Buffer.from(DA2062_BASE64, "base64");

// Header line for FROM/TO: DCSIM shows "DCSIM · <tech name>"; otherwise "<rank> <name>".
function partyHeader(p: ReceiptParty): string {
  if (p.isDcsim) return `DCSIM · ${p.name}`;
  return p.rank ? `${p.rank} ${p.name}` : p.name;
}

// Multi-line block for the custody record page.
function partyBlock(p: ReceiptParty): string[] {
  if (p.isDcsim) return ["DCSIM", `Technician: ${p.name}`];
  return [
    p.rank ? `${p.rank} ${p.name}` : p.name,
    p.unit ? `Unit: ${p.unit}` : "Unit: —",
    p.contact ? `Contact: ${p.contact}` : "Contact: —",
    p.email ? `Email: ${p.email}` : "Email: —",
  ];
}

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
      field.setFontSize(opts.size ?? 10);
      field.setText(value);
    } catch {
      /* field not present in this template revision — ignore */
    }
  };

  set("FROM", partyHeader(t.sender), { size: 11 });
  set("TO", partyHeader(t.receiver), { size: 11 });
  set("HAND RECEIPT IDENTIFIER", t.receiptNumber, { size: 11 });

  set("ITEM NO aRow1", "1", { size: 9, center: true });
  set("ITEM DESCRIPTION cRow1", `${t.item.make} ${t.item.model}\nSER NO: ${t.item.serialNumber}`, { multiline: true, size: 9 });
  set("UI.0", "EA", { size: 9, center: true });
  set("QTY.0", "1", { size: 9, center: true });

  form.updateFieldAppearances(helv);
  form.flatten();

  // --- Column A: quantity + recipient signature (vertical) + guard bars.
  const page1 = pdf.getPage(0);
  const black = rgb(0, 0, 0);
  const colLeft = 621, colWidth = 23, colCenter = 632, rowTopY = 486, tableBottomY = 58;
  const dateStr = formatDateHST(t.createdAt);

  page1.drawText("1", { x: colCenter - helv.widthOfTextAtSize("1", 9) / 2, y: 492, size: 9, font: helv });

  const sigBottom = 350;
  let blockTop = sigBottom;
  let drewImage = false;
  if (t.receiverSignature && t.receiverSignature.startsWith("data:image/png;base64,")) {
    try {
      const sig = await pdf.embedPng(Buffer.from(t.receiverSignature.split(",")[1], "base64"));
      const barH = 22;
      const barW = Math.min(barH * (sig.width / sig.height), 72);
      page1.drawImage(sig, { x: 642, y: sigBottom, width: barW, height: barH, rotate: degrees(90) });
      const dateY = sigBottom + barW + 10;
      page1.drawText(dateStr, { x: colCenter + 4, y: dateY, size: 9, font: helv, rotate: degrees(90) });
      blockTop = dateY + helv.widthOfTextAtSize(dateStr, 9);
      drewImage = true;
    } catch {
      /* fall through */
    }
  }
  if (!drewImage) {
    const label = `${partyHeader(t.receiver)}   ${dateStr}`;
    page1.drawText(label, { x: colCenter + 4, y: sigBottom, size: 9, font: helv, rotate: degrees(90) });
    blockTop = sigBottom + helv.widthOfTextAtSize(label, 9);
  }
  page1.drawRectangle({ x: colLeft, y: tableBottomY, width: colWidth, height: sigBottom - 4 - tableBottomY, color: black });
  if (rowTopY - (blockTop + 2) > 1) {
    page1.drawRectangle({ x: colLeft, y: blockTop + 2, width: colWidth, height: rowTopY - (blockTop + 2), color: black });
  }

  // --- Custody record page: both parties in full, QR, signature.
  const page = pdf.addPage([612, 792]);
  const ink = rgb(0.06, 0.09, 0.16), muted = rgb(0.4, 0.45, 0.5);
  let y = 730;
  page.drawText("CUSTODY TRANSFER RECORD", { x: 56, y, size: 16, font: bold, color: ink });
  page.drawText(t.receiptNumber, { x: 56, y: y - 18, size: 10, font: helv, color: muted });

  // QR (top-right) linking to the public receipt page.
  try {
    const qrDataUrl = await QRCode.toDataURL(t.receiptUrl, { margin: 1, width: 256 });
    const qr = await pdf.embedPng(Buffer.from(qrDataUrl.split(",")[1], "base64"));
    page.drawImage(qr, { x: 470, y: 690, width: 86, height: 86 });
  } catch {
    /* QR optional — skip on failure */
  }

  y -= 50;
  const meta: [string, string][] = [
    ["Item", `${t.item.make} ${t.item.model}`],
    ["Serial number", t.item.serialNumber],
    ["Home unit", t.item.homeUnit ?? "—"],
    ["Quantity / U/I", "1 EA"],
    ["Date", dateStr],
    ["Status", t.status],
  ];
  for (const [k, v] of meta) {
    page.drawText(k, { x: 56, y, size: 11, font: bold, color: muted });
    page.drawText(v, { x: 200, y, size: 12, font: helv, color: ink });
    y -= 22;
  }

  y -= 16;
  for (const [title, party] of [["FROM (sender)", t.sender], ["TO (recipient)", t.receiver]] as const) {
    page.drawText(title, { x: 56, y, size: 11, font: bold, color: muted });
    y -= 16;
    for (const line of partyBlock(party)) {
      page.drawText(line, { x: 66, y, size: 11, font: helv, color: ink });
      y -= 15;
    }
    y -= 10;
  }

  y -= 6;
  page.drawText("Recipient signature", { x: 56, y, size: 11, font: bold, color: muted });
  y -= 14;
  if (t.receiverSignature && t.receiverSignature.startsWith("data:image/png;base64,")) {
    try {
      const png = await pdf.embedPng(Buffer.from(t.receiverSignature.split(",")[1], "base64"));
      const w = 260, h = Math.min((png.height / png.width) * w, 110);
      page.drawImage(png, { x: 56, y: y - h, width: w, height: h });
      y -= h;
    } catch {
      page.drawText("(signature on file)", { x: 56, y: y - 12, size: 11, font: helv, color: muted });
      y -= 24;
    }
  } else {
    page.drawText("(no signature captured)", { x: 56, y: y - 12, size: 11, font: helv, color: muted });
    y -= 24;
  }
  page.drawLine({ start: { x: 56, y: y - 10 }, end: { x: 320, y: y - 10 }, thickness: 0.5, color: muted });
  page.drawText(`${partyHeader(t.receiver)} · ${dateStr}`, { x: 56, y: y - 24, size: 10, font: helv, color: muted });

  return pdf.save();
}
