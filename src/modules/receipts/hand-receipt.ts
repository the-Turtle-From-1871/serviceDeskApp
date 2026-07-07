import { PDFDocument, StandardFonts, rgb, TextAlignment } from "pdf-lib";
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
  lines: { lineNo: number; make: string; model: string; unitOfIssue: string; serials: string[]; qtyAuth: number; qtyIssued: number }[];
  sender: ReceiptParty;
  receiver: ReceiptParty;
};

const templateBytes = () => Buffer.from(DA2062_BASE64, "base64");

// FROM/TO line: DCSIM shows "DCSIM · <name>"; a non-DCSIM party shows
// "RANK Name, Unit, Contact" with any missing field omitted.
export function partyHeader(p: ReceiptParty): string {
  if (p.isDcsim) return `DCSIM · ${p.name}`;
  const nameLine = p.rank ? `${p.rank} ${p.name}` : p.name;
  return [nameLine, p.unit ?? undefined, p.contact ?? undefined].filter(Boolean).join(", ");
}

// Short label for internal, fixed-size renders (guard-column label, custody
// footer) that have no fit-to-box shrinking. Keeps the pre-change behavior.
export function partyHeaderShort(p: ReceiptParty): string {
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
    opts: { multiline?: boolean; size?: number; center?: boolean; fitWidth?: boolean } = {}
  ) => {
    try {
      const field = form.getTextField(name);
      if (opts.multiline) field.enableMultiline();
      if (opts.center) field.setAlignment(TextAlignment.Center);
      let size = opts.size ?? 10;
      if (opts.fitWidth) {
        // Shrink the font until the value fits the widget's inner width, so a
        // long "RANK Name, Unit, Contact" line never overflows the box.
        const rect = field.acroField.getWidgets()[0].getRectangle();
        const maxW = rect.width - 6;
        while (size > 6 && helv.widthOfTextAtSize(value, size) > maxW) size -= 0.5;
      }
      field.setFontSize(size);
      field.setText(value);
    } catch {
      /* field not present in this template revision — ignore */
    }
  };

  set("FROM", partyHeader(t.sender), { size: 10, fitWidth: true, multiline: true });
  set("TO", partyHeader(t.receiver), { size: 10, fitWidth: true, multiline: true });
  set("HAND RECEIPT IDENTIFIER", t.receiptNumber, { size: 11 });

  t.lines.forEach((ln, i) => {
    set(`ITEM NO aRow${ln.lineNo}`, String(ln.lineNo), { size: 9, center: true });
    set(`ITEM DESCRIPTION cRow${ln.lineNo}`, `${ln.make} ${ln.model}\nSER NO: ${ln.serials.join(", ")}`, { multiline: true, size: 9 });
    set(`UI.${i}`, ln.unitOfIssue, { size: 9, center: true });
    set(`QTY.${i}`, String(ln.qtyAuth), { size: 9, center: true }); // QTY AUTH column
  });

  form.updateFieldAppearances(helv);
  form.flatten();

  // --- Column A: per-row issued quantity + guard bar (no signature here —
  // the recipient signature now lives in its own block below the table).
  const page1 = pdf.getPage(0);
  const black = rgb(0, 0, 0);
  const colLeft = 621, colWidth = 23, colCenter = 632, rowTopY = 486, tableBottomY = 58;
  const dateStr = formatDateHST(t.createdAt);

  const rowH = 24; // template row pitch
  // Issued numbers were landing one row below their item row; anchor their
  // loop one row height above the shared rowTopY (used by the guard-bar
  // blackout rectangle below, which must NOT shift).
  const issuedTopY = rowTopY + rowH;
  t.lines.forEach((ln) => {
    const rowCenterY = issuedTopY - (ln.lineNo - 0.5) * rowH;
    const label = String(ln.qtyIssued);
    page1.drawText(label, { x: colCenter - helv.widthOfTextAtSize(label, 9) / 2, y: rowCenterY, size: 9, font: helv });
  });

  // Black out the unused lower portion of Column A below the last populated row.
  const lastRowBottom = rowTopY - t.lines.length * rowH;
  if (lastRowBottom - tableBottomY > 1) {
    page1.drawRectangle({ x: colLeft, y: tableBottomY, width: colWidth, height: lastRowBottom - tableBottomY, color: black });
  }

  // Recipient signature block, below the item table (not in Column A).
  const sigY = 40;
  if (t.receiverSignature.startsWith("data:image/png;base64,")) {
    try {
      const sig = await pdf.embedPng(Buffer.from(t.receiverSignature.split(",")[1], "base64"));
      const w = 120, h = Math.min((sig.height / sig.width) * w, 28);
      page1.drawImage(sig, { x: 250, y: sigY, width: w, height: h });
    } catch { /* fall through to text */ }
  }
  page1.drawText(`${partyHeaderShort(t.receiver)}  ${dateStr}`, { x: 250, y: sigY - 10, size: 8, font: helv });

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
  page.drawText("Items", { x: 56, y, size: 11, font: bold, color: muted });
  y -= 18;
  for (const ln of t.lines) {
    page.drawText(`${ln.lineNo}. ${ln.make} ${ln.model} — auth ${ln.qtyAuth} / issued ${ln.qtyIssued} ${ln.unitOfIssue}`, { x: 66, y, size: 11, font: helv, color: ink });
    y -= 15;
    page.drawText(`SER: ${ln.serials.join(", ")}`, { x: 76, y, size: 9, font: helv, color: muted });
    y -= 18;
  }
  const meta: [string, string][] = [["Date", dateStr], ["Status", t.status]];
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
  page.drawText(`${partyHeaderShort(t.receiver)} · ${dateStr}`, { x: 56, y: y - 24, size: 10, font: helv, color: muted });

  return pdf.save();
}
