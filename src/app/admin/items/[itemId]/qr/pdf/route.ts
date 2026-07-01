import { requireAdmin, AuthError } from "@/lib/authz";
import { getItem } from "@/modules/items/items.service";
import { buildItemQrPdf } from "@/modules/receipts/qr-pdf";

export async function GET(_req: Request, { params }: { params: Promise<{ itemId: string }> }) {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) return new Response(e.code, { status: e.code === "FORBIDDEN" ? 403 : 401 });
    throw e;
  }
  const { itemId } = await params;
  const item = await getItem(itemId);
  if (!item) return new Response("Not found", { status: 404 });

  const bytes = await buildItemQrPdf(item);
  const filename = `qr-${item.serialNumber}.pdf`.replace(/[^\w.\-]+/g, "_");
  return new Response(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
