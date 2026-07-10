import "server-only";
import { getTransferByReceiptNumber } from "@/modules/transfers/transfers.service";
import { getClosingReturn, listReturnsForReceipt } from "@/modules/returns/returns.service";
import { buildHandReceiptPdf, type ReceiptParty } from "@/modules/receipts/hand-receipt";
import { receiptUrl } from "@/modules/items/qr";

// Build a line's successive quantity-column values (DA 2062 columns A–F): column
// A is the issued qty, and each return TRANSACTION is the next column with the
// line's balance after it (unchanged if that return took none of this line's
// items) — one column per transaction so the columns line up with the
// per-transaction signatures. Capped at 6 columns.
function quantityColumns(qtyIssued: number, serials: string[], returns: { returned: unknown }[]): number[] {
  const serialSet = new Set(serials);
  const columns = [qtyIssued];
  let bal = qtyIssued;
  for (const rt of returns) {
    if (columns.length >= 6) break;
    const items = Array.isArray(rt.returned) ? (rt.returned as { serialNumber?: string }[]) : [];
    const n = items.filter((r) => r.serialNumber && serialSet.has(r.serialNumber)).length;
    bal = Math.max(0, bal - n);
    columns.push(bal);
  }
  return columns;
}

// Fetch a receipt by number and render its DA-2062 PDF (partial returns redline
// Column A; a closed receipt gets the CLOSED watermark + closing-tech attestation).
// Returns null if the receipt does not exist.
export async function renderReceiptPdf(receiptNumber: string): Promise<Uint8Array | null> {
  const t = await getTransferByReceiptNumber(receiptNumber);
  if (!t) return null;

  const sender: ReceiptParty = {
    isDcsim: t.senderIsDcsim, name: t.senderName, rank: t.senderRank, unit: t.senderUnit, contact: t.senderContact, email: t.senderEmail,
  };
  const receiver: ReceiptParty = {
    isDcsim: t.receiverIsDcsim, name: t.receiverName, rank: t.receiverRank, unit: t.receiverUnit, contact: t.receiverContact, email: t.receiverEmail,
  };

  let closedBy: { name: string; signature: string; date: Date } | undefined;
  if (t.status === "CLOSED") {
    const cr = await getClosingReturn(t.id);
    if (cr) closedBy = { name: cr.processedByName, signature: cr.processedBySignature ?? "", date: cr.createdAt };
  }

  const returns = await listReturnsForReceipt(t.id);

  // One signature block per return transaction, mapped to columns B, C, … (column
  // A carries the recipient/issuance signature already on ReceiptData).
  const columnSignatures = returns.slice(0, 5).map((rt) => ({
    signature: rt.processedBySignature ?? "",
    date: rt.createdAt,
    name: rt.processedByName,
  }));

  return buildHandReceiptPdf({
    receiptNumber: t.receiptNumber,
    status: t.status,
    createdAt: t.createdAt,
    receiptUrl: receiptUrl(t.receiptNumber),
    receiverSignature: t.receiverSignature,
    lines: t.lines.map((ln) => {
      const serials = ln.items.map((it) => it.serialNumber);
      return {
        lineNo: ln.lineNo, make: ln.make, model: ln.model, unitOfIssue: ln.unitOfIssue,
        serials, qtyAuth: ln.qtyAuth, qtyIssued: ln.qtyIssued,
        qtyColumns: quantityColumns(ln.qtyIssued, serials, returns),
      };
    }),
    sender, receiver, closedBy, columnSignatures,
  });
}
