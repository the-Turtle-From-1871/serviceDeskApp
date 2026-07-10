import { requireAdmin, AuthError } from "@/lib/authz";
import { getItemsByIds } from "@/modules/items/items.service";
import { buildItemsQrSheetPdf } from "@/modules/items/qr-sheet";

// Bulk QR-label sheet for the items selected on the list page:
// GET /admin/items/qr-sheet/pdf?items=id,id,id[&preview]
export async function GET(req: Request) {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) return new Response(e.code, { status: e.code === "FORBIDDEN" ? 403 : 401 });
    throw e;
  }

  const url = new URL(req.url);
  const ids = (url.searchParams.get("items") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) return new Response("No items selected", { status: 400 });

  const items = await getItemsByIds(ids);
  if (items.length === 0) return new Response("Not found", { status: 404 });

  const bytes = await buildItemsQrSheetPdf(items);
  const inline = url.searchParams.has("preview");
  return new Response(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="qr-labels.pdf"`,
    },
  });
}
