import { renderReceiptPdf } from "@/modules/receipts/render";

// PUBLIC BY DESIGN (reviewed exception to the "auth-first" guardrail): hand
// receipts are intentionally public so recipients without accounts can look up
// and download their own receipt by number/serial. No per-user ownership model.
export async function GET(req: Request, { params }: { params: Promise<{ receiptNumber: string }> }) {
  const { receiptNumber } = await params;
  const bytes = await renderReceiptPdf(receiptNumber);
  if (!bytes) return new Response("Not found", { status: 404 });

  const inline = new URL(req.url).searchParams.has("preview");
  return new Response(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="hand-receipt-${receiptNumber.toUpperCase()}.pdf"`,
    },
  });
}
