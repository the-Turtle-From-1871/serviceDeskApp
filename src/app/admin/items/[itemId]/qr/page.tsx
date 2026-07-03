import Link from "next/link";
import { notFound } from "next/navigation";
import { getItem } from "@/modules/items/items.service";
import { itemQrDataUrl, itemUrl } from "@/modules/items/qr";

export default async function QrPage({ params }: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await params;
  const item = await getItem(itemId);
  if (!item) notFound();
  const png = await itemQrDataUrl(item.id);
  const url = itemUrl(item.id);
  return (
    <div className="card qr-card stack">
      <div>
        <h1 className="page-title" style={{ fontSize: 22 }}>{item.make} {item.model}</h1>
        <p className="subtle">Serial {item.serialNumber}</p>
      </div>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={png} alt={`QR code for ${item.make} ${item.model}`} width={320} height={320} style={{ margin: "0 auto" }} />
      <p className="qr-url">{url}</p>
      <div className="row no-print" style={{ justifyContent: "center" }}>
        <a href={`/admin/items/${item.id}/qr/pdf`} className="btn btn-primary">Download label (PDF)</a>
        <Link href="/items" className="btn btn-ghost">Back to items</Link>
      </div>
    </div>
  );
}
