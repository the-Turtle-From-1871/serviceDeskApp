import { notFound, redirect } from "next/navigation";
import { getItem } from "@/modules/items/items.service";
import { itemQrDataUrl, itemUrl } from "@/modules/items/qr";
import { PrintButton } from "@/components/PrintButton";
import { requireAdmin, AuthError } from "@/lib/authz";

export default async function QrPage({ params }: { params: Promise<{ itemId: string }> }) {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) redirect(e.code === "FORBIDDEN" ? "/dashboard" : "/login");
    throw e;
  }
  const { itemId } = await params;
  const item = await getItem(itemId);
  if (!item) notFound();
  const [png, url] = await Promise.all([itemQrDataUrl(item.id), Promise.resolve(itemUrl(item.id))]);
  return (
    <div style={{ textAlign: "center" }}>
      <h1>
        {item.make} {item.model}
      </h1>
      <p>
        Serial: {item.serialNumber}
        {item.assetTag ? ` · Tag: ${item.assetTag}` : ""}
      </p>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={png} alt={`QR code for ${item.make} ${item.model}`} width={320} height={320} />
      <p style={{ fontSize: 12, wordBreak: "break-all" }}>{url}</p>
      <PrintButton />
    </div>
  );
}
