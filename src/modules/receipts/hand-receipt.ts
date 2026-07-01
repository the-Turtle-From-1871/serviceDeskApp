import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { DA2062_BASE64 } from "./templates/da2062.base64";

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
  return d ? new Date(d).toISOString().slice(0, 10) : "—";
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
  const set = (name: string, value: string) => {
    try {
      form.getTextField(name).setText(value);
    } catch {
      /* field not present in this template revision — ignore */
    }
  };

  const desc = `${t.item.make} ${t.item.model}, SN ${t.item.serialNumber}`;
  set("FROM", t.fromUserName ?? "Initial issue");
  set("TO", t.toUserName);
  set("HAND RECEIPT IDENTIFIER", `HR-${t.id.slice(0, 8).toUpperCase()}`);
  set("END ITEM DESCRIPTION", desc);
  set("QUANTITY", "1");
  set("ITEM NO aRow1", "1");
  set("MATERIAL NUMBER bRow1", t.item.assetTag ?? t.item.serialNumber);
  set("ITEM DESCRIPTION cRow1", desc);

  form.updateFieldAppearances(helv);
  form.flatten();

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
    ["Asset tag", t.item.assetTag ?? "—"],
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
