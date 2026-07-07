import { getTransferByReceiptNumber } from "@/modules/transfers/transfers.service";
import { buildHandReceiptPdf, type ReceiptParty } from "@/modules/receipts/hand-receipt";
import { receiptUrl } from "@/modules/items/qr";

// PUBLIC BY DESIGN (reviewed exception to the "auth-first" guardrail): hand
// receipts are intentionally public so recipients without accounts can look up
// and download their own receipt by number/serial. No per-user ownership model.
export async function GET(_req: Request, { params }: { params: Promise<{ receiptNumber: string }> }) {
  const { receiptNumber } = await params;
  const t = await getTransferByReceiptNumber(receiptNumber);
  if (!t) return new Response("Not found", { status: 404 });

  const sender: ReceiptParty = {
    isDcsim: t.senderIsDcsim, name: t.senderName, rank: t.senderRank, unit: t.senderUnit, contact: t.senderContact, email: t.senderEmail,
  };
  const receiver: ReceiptParty = {
    isDcsim: t.receiverIsDcsim, name: t.receiverName, rank: t.receiverRank, unit: t.receiverUnit, contact: t.receiverContact, email: t.receiverEmail,
  };

  const bytes = await buildHandReceiptPdf({
    receiptNumber: t.receiptNumber,
    status: t.status,
    createdAt: t.createdAt,
    receiptUrl: receiptUrl(t.receiptNumber),
    receiverSignature: t.receiverSignature,
    lines: t.lines.map((ln) => ({
      lineNo: ln.lineNo,
      make: ln.make,
      model: ln.model,
      unitOfIssue: ln.unitOfIssue,
      serials: ln.items.map((it) => it.serialNumber),
      qtyAuth: ln.qtyAuth,
      qtyIssued: ln.qtyIssued,
    })),
    sender,
    receiver,
  });

  return new Response(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="hand-receipt-${t.receiptNumber}.pdf"`,
    },
  });
}
