import Link from "next/link";
import { notFound } from "next/navigation";
import { getItem } from "@/modules/items/items.service";
import { listReceiptsForItem } from "@/modules/transfers/transfers.service";
import { itemQrDataUrl, itemUrl } from "@/modules/items/qr";
import { StatusBadge } from "@/components/StatusBadge";
import { formatDateTimeHST } from "@/lib/datetime";

function partyLabel(p: { isDcsim: boolean; name: string; rank: string | null; unit: string | null }): string {
  if (p.isDcsim) return `DCSIM · ${p.name}`;
  const head = p.rank ? `${p.rank} ${p.name}` : p.name;
  return p.unit ? `${head} (${p.unit})` : head;
}

export default async function PublicItemPage({ params }: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await params;
  const item = await getItem(itemId);
  if (!item) notFound();
  const [receipts, qr] = await Promise.all([
    listReceiptsForItem(item.id),
    itemQrDataUrl(item.id).catch(() => ""),
  ]);
  return (
    <>
      <header className="app-header">
        <div className="app-header__inner">
          <Link href="/" className="brand"><span className="brand__mark">HR</span>Hand Receipt</Link>
          <span className="spacer" />
          <Link href="/" className="btn btn-ghost btn-sm">Search</Link>
        </div>
      </header>
      <main className="container container-mid stack">
        <div className="row">
          <div>
            <h1 className="page-title">{item.make} {item.model}</h1>
            <p className="subtle">Serial {item.serialNumber}{item.homeUnit ? ` · ${item.homeUnit}` : ""}</p>
          </div>
          <span className="spacer" />
          <StatusBadge status={item.status} />
        </div>

        {qr && (
          <div className="card stack-sm" style={{ textAlign: "center" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qr} alt={`QR code for ${item.make} ${item.model}`} width={220} height={220} style={{ margin: "0 auto" }} />
            <p className="subtle">Scan to view this item · {itemUrl(item.id)}</p>
          </div>
        )}

        <div className="card">
          <div className="card__title">Hand receipts</div>
          {receipts.length === 0 ? (
            <p className="subtle">No hand receipts recorded for this item yet.</p>
          ) : (
            <ul className="stack-sm">
              {receipts.map((t) => (
                <li key={t.id} className="row">
                  <div>
                    <div><Link href={`/receipts/${t.receiptNumber}`}><strong>{t.receiptNumber}</strong></Link></div>
                    <div className="subtle">
                      {partyLabel({ isDcsim: t.senderIsDcsim, name: t.senderName, rank: t.senderRank, unit: t.senderUnit })}
                      {" → "}
                      {partyLabel({ isDcsim: t.receiverIsDcsim, name: t.receiverName, rank: t.receiverRank, unit: t.receiverUnit })}
                      {" · "}{formatDateTimeHST(t.createdAt)}
                    </div>
                  </div>
                  <span className="spacer" />
                  <a className="btn btn-secondary btn-sm" href={`/receipts/${t.receiptNumber}/pdf`}>Download PDF</a>
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>
    </>
  );
}
