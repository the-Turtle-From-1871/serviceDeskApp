import Link from "next/link";
import { notFound } from "next/navigation";
import { getItemWithCreator } from "@/modules/items/items.service";
import { listReceiptsForItem } from "@/modules/transfers/transfers.service";
import { formatParty } from "@/modules/transfers/party";
import { itemQrDataUrl, itemUrl } from "@/modules/items/qr";
import { StatusBadge } from "@/components/StatusBadge";
import { formatDateTimeHST } from "@/lib/datetime";
import { SiteHeader } from "@/components/SiteHeader";
import { getCurrentUser } from "@/lib/session";

export default async function PublicItemPage({ params }: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await params;
  // All four fetches depend only on itemId (known up front), so run them together.
  const [item, user, receipts, qr] = await Promise.all([
    getItemWithCreator(itemId),
    getCurrentUser(),
    listReceiptsForItem(itemId),
    itemQrDataUrl(itemId).catch((e) => { console.error("[item-page] QR generation failed:", e); return ""; }),
  ]);
  if (!item) notFound();
  const loggedIn = !!user && user.isActive;
  const isAdmin = user?.role === "ADMIN";
  // Current custodian = most recent OPEN transfer's receiver; a CLOSED
  // transfer must never read as the holder.
  const currentHolder = receipts.find((t) => t.status === "OPEN");
  return (
    <>
      <SiteHeader />
      <main className="container container-mid stack">
        <div className="row">
          <div>
            <h1 className="page-title">{item.make} {item.model}</h1>
            <p className="subtle">Serial {item.serialNumber}{item.homeUnit ? ` · ${item.homeUnit}` : ""}</p>
          </div>
          <span className="spacer" />
          <StatusBadge status={item.status} />
        </div>

        {loggedIn && (
          <div className="card">
            <div className="card__title">Item details</div>
            <dl className="dl">
              {isAdmin && (
                <>
                  <dt>Notes</dt>
                  <dd>{item.notes || "—"}</dd>
                </>
              )}
              <dt>Date logged</dt>
              <dd>{formatDateTimeHST(item.createdAt)}</dd>
              <dt>Logged by</dt>
              <dd>{item.createdBy ? formatParty({ isDcsim: false, name: item.createdBy.name, rank: item.createdBy.rank, unit: null }) : "—"}</dd>
              <dt>Current holder</dt>
              <dd>
                {currentHolder
                  ? formatParty({ isDcsim: currentHolder.receiverIsDcsim, name: currentHolder.receiverName, rank: currentHolder.receiverRank, unit: currentHolder.receiverUnit })
                  : "Not yet transferred"}
              </dd>
            </dl>
          </div>
        )}

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
                      {formatParty({ isDcsim: t.senderIsDcsim, name: t.senderName, rank: t.senderRank, unit: t.senderUnit })}
                      {" → "}
                      {formatParty({ isDcsim: t.receiverIsDcsim, name: t.receiverName, rank: t.receiverRank, unit: t.receiverUnit })}
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
