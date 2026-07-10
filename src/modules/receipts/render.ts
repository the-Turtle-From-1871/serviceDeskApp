import "server-only";
import { getTransferByReceiptNumber } from "@/modules/transfers/transfers.service";
import { getClosingReturn } from "@/modules/returns/returns.service";
import { buildHandReceiptPdf, type ReceiptParty } from "@/modules/receipts/hand-receipt";
import { receiptUrl } from "@/modules/items/qr";

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

  return buildHandReceiptPdf({
    receiptNumber: t.receiptNumber,
    status: t.status,
    createdAt: t.createdAt,
    receiptUrl: receiptUrl(t.receiptNumber),
    receiverSignature: t.receiverSignature,
    lines: t.lines.map((ln) => ({
      lineNo: ln.lineNo, make: ln.make, model: ln.model, unitOfIssue: ln.unitOfIssue,
      serials: ln.items.map((it) => it.serialNumber),
      qtyAuth: ln.qtyAuth, qtyIssued: ln.qtyIssued,
      heldQty: ln.items.filter((it) => it.returnedAt === null).length,
    })),
    sender, receiver, closedBy,
  });
}
