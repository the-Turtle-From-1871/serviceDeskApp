import { requireUser, AuthError } from "@/lib/authz";
import { getItem } from "@/modules/items/items.service";
import { buildItemsQrSheetPdf } from "@/modules/items/qr-sheet";

// Printable QR label for a single item, in the SAME format as the items-list
// multi-select QR sheet (buildItemsQrSheetPdf) — called with one item. Served
// as a PDF because iOS/WKWebView does not implement window.print(), so a
// browser-print button silently does nothing there; a PDF opens in the native
// viewer with Share -> Print / Save to Files on mobile, and prints on desktop.
// GET /i/<itemId>/qr/pdf
export async function GET(_req: Request, { params }: { params: Promise<{ itemId: string }> }) {
  try {
    await requireUser();
  } catch (e) {
    if (e instanceof AuthError) return new Response(e.code, { status: e.code === "FORBIDDEN" ? 403 : 401 });
    throw e;
  }
  const { itemId } = await params;
  const item = await getItem(itemId);
  if (!item) return new Response("Not found", { status: 404 });

  const bytes = await buildItemsQrSheetPdf([{ id: item.id, serialNumber: item.serialNumber }]);
  const filename = `qr-${item.serialNumber}.pdf`.replace(/[^\w.\-]+/g, "_");
  return new Response(Buffer.from(bytes), {
    // inline so mobile opens it in the PDF viewer (Share -> Print), not a silent download.
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${filename}"` },
  });
}
