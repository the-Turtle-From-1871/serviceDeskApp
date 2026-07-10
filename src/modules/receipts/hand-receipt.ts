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
  lines: { lineNo: number; make: string; model: string; unitOfIssue: string; serials: string[]; qtyAuth: number; qtyIssued: number; heldQty?: number }[];
  sender: ReceiptParty;
  receiver: ReceiptParty;
  closedBy?: { name: string; signature: string; date: Date };
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
    opts: { multiline?: boolean; size?: number; center?: boolean; fitWidth?: boolean; fitBox?: boolean } = {}
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
      if (opts.fitBox) {
        const rect = field.acroField.getWidgets()[0].getRectangle();
        const maxW = rect.width - 6, maxH = rect.height - 4;
        const paras = value.split("\n");
        const fits = (s: number) => {
          let lines = 0;
          for (const p of paras) lines += Math.max(1, Math.ceil(helv.widthOfTextAtSize(p, s) / maxW));
          return lines * s * 1.15 <= maxH;
        };
        while (size > 5 && !fits(size)) size -= 0.5;
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
    set(`ITEM DESCRIPTION cRow${ln.lineNo}`, `${ln.make} ${ln.model}\nSER NO: ${ln.serials.join(", ")}`, { multiline: true, size: 9, fitBox: true });
    set(`UI.${i}`, ln.unitOfIssue, { size: 9, center: true });
    set(`QTY.${i}`, String(ln.qtyAuth), { size: 9, center: true }); // QTY AUTH column
  });

  form.updateFieldAppearances(helv);
  form.flatten();

  // --- Column A: per-row issued quantity at the top, then the recipient
  // signature + date drawn VERTICALLY in the empty column below the last item
  // row, with guard bars blacking out the remaining empty space (DA 2062 layout).
  const page1 = pdf.getPage(0);
  const black = rgb(0, 0, 0), red = rgb(0.78, 0.12, 0.12);
  const colLeft = 621, colWidth = 23, colCenter = 632, rowTopY = 486, tableBottomY = 58;
  const dateStr = formatDateHST(t.createdAt);

  const rowH = 24; // template row pitch
  // Issued numbers were landing one row below their item row; anchor their
  // loop one row height above rowTopY so each lands on its own item row.
  const issuedTopY = rowTopY + rowH;
  t.lines.forEach((ln) => {
    const rowCenterY = issuedTopY - (ln.lineNo - 0.5) * rowH;
    const held = ln.heldQty ?? ln.serials.length;
    // When items were actually returned (held below the line's serial count),
    // show only the current still-held balance (red) — not the old issued qty.
    // Gate on serial count, not the typed issued qty, so a receipt with no
    // returns never adjusts even if a typed issued qty differs from the count.
    if (held < ln.serials.length) {
      const label = String(held);
      page1.drawText(label, { x: colCenter - bold.widthOfTextAtSize(label, 9) / 2, y: rowCenterY, size: 9, font: bold, color: red });
    } else {
      const label = String(ln.qtyIssued);
      page1.drawText(label, { x: colCenter - helv.widthOfTextAtSize(label, 9) / 2, y: rowCenterY, size: 9, font: helv });
    }
  });

  // Recipient signature + date sit vertically in the column below the last row.
  const lastRowBottom = issuedTopY - t.lines.length * rowH;
  const sigBottom = Math.max(tableBottomY + 130, lastRowBottom - 150);
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
      /* fall through to the text label below */
    }
  }
  if (!drewImage) {
    const label = `${partyHeaderShort(t.receiver)}   ${dateStr}`;
    page1.drawText(label, { x: colCenter + 4, y: sigBottom, size: 9, font: helv, rotate: degrees(90) });
    blockTop = sigBottom + helv.widthOfTextAtSize(label, 9);
  }
  // Guard bar below the signature block, down to the table bottom.
  if (sigBottom - 4 - tableBottomY > 1) {
    page1.drawRectangle({ x: colLeft, y: tableBottomY, width: colWidth, height: sigBottom - 4 - tableBottomY, color: black });
  }
  // Guard bar above the signature block, up to the bottom of the last item row.
  if (lastRowBottom - (blockTop + 2) > 1) {
    page1.drawRectangle({ x: colLeft, y: blockTop + 2, width: colWidth, height: lastRowBottom - (blockTop + 2), color: black });
  }

  // When the receipt is closed (all property returned), stamp the form page with
  // a diagonal CLOSED watermark and strike the recipient signature block,
  // per the DA 2062 "redline" clear-out treatment.
  if (t.status === "CLOSED") {
    const { width, height } = page1.getSize();
    page1.drawText("CLOSED", {
      x: width * 0.24,
      y: height * 0.42,
      size: 72,
      font: bold,
      color: red,
      rotate: degrees(35),
      opacity: 0.28,
    });
    // Strike through the vertical signature block in muted red.
    page1.drawLine({
      start: { x: colLeft - 2, y: sigBottom },
      end: { x: colLeft + colWidth + 2, y: blockTop + 2 },
      thickness: 2,
      color: red,
    });
  }

  // Closing-technician attestation drawn in the open body of the FORM page,
  // alongside the CLOSED marking: printed name, date, and signature (bold).
  if (t.closedBy) {
    const ax = 232;
    let ay = 368;
    page1.drawText(`Accepted by: ${t.closedBy.name}`, { x: ax, y: ay, size: 12, font: bold, color: black });
    ay -= 18;
    page1.drawText(`Date: ${formatDateHST(t.closedBy.date)}`, { x: ax, y: ay, size: 12, font: bold, color: black });
    ay -= 10;
    if (t.closedBy.signature && t.closedBy.signature.startsWith("data:image/png;base64,")) {
      try {
        const csig = await pdf.embedPng(Buffer.from(t.closedBy.signature.split(",")[1], "base64"));
        const w = 200, h = Math.min((csig.height / csig.width) * w, 66);
        page1.drawImage(csig, { x: ax, y: ay - h, width: w, height: h });
      } catch {
        /* signature optional — skip on failure */
      }
    }
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
  page.drawText("Items", { x: 56, y, size: 11, font: bold, color: muted });
  y -= 18;
  for (const ln of t.lines) {
    const heldStr = ln.heldQty !== undefined && ln.heldQty < ln.serials.length ? ` · ${ln.heldQty} still held` : "";
    page.drawText(`${ln.lineNo}. ${ln.make} ${ln.model} — auth ${ln.qtyAuth} / issued ${ln.qtyIssued} ${ln.unitOfIssue}${heldStr}`, { x: 66, y, size: 11, font: helv, color: ink });
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
