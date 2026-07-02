import { getTransferByReceiptNumber } from "@/modules/transfers/transfers.service";
import { buildHandReceiptPdf, type ReceiptParty } from "@/modules/receipts/hand-receipt";
import { receiptUrl } from "@/modules/items/qr";

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
    item: { make: t.item.make, model: t.item.model, serialNumber: t.item.serialNumber, homeUnit: t.item.homeUnit },
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
