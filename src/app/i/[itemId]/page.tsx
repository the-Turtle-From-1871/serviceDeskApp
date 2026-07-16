import Link from "next/link";
import { notFound } from "next/navigation";
import { getItemWithCreator } from "@/modules/items/items.service";
import { listReceiptsForItem, getHoldingTransfer } from "@/modules/transfers/transfers.service";
import { formatParty } from "@/modules/transfers/party";
import { itemQrDataUrl, itemUrl } from "@/modules/items/qr";
import { StatusBadge } from "@/components/StatusBadge";
import { formatDateTimeHST } from "@/lib/datetime";
import { SiteHeader } from "@/components/SiteHeader";
import { getCurrentUser } from "@/lib/session";
import { getServiceRequestForItem } from "@/modules/service-queue/service-queue.service";
import { serviceTypeLabel } from "@/modules/service-queue/service-queue.status";
import { ServiceControls } from "./ServiceControls";
import prisma from "@/lib/prisma";
import { listUnits } from "@/modules/items/units.service";
import { ItemDetailsCard } from "./ItemDetailsCard";

export default async function PublicItemPage({ params }: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await params;
  // All fetches depend only on itemId (known up front), so run them together.
  const [item, user, receipts, currentHolder, qr, service, units, lastEdit] = await Promise.all([
    getItemWithCreator(itemId),
    getCurrentUser(),
    listReceiptsForItem(itemId),
    // Custody is NOT `receipts.find(t => t.status === "OPEN")`: a PARTIAL return
    // leaves the receipt OPEN, so that would still name the customer as holding
    // an item they already handed back. getHoldingTransfer checks this item's
    // own returnedAt.
    getHoldingTransfer(itemId),
    itemQrDataUrl(itemId).catch((e) => { console.error("[item-page] QR generation failed:", e); return ""; }),
    getServiceRequestForItem(itemId),
    listUnits(),
    prisma.itemEdit.findFirst({ where: { itemId }, orderBy: { createdAt: "desc" } }),
  ]);
  if (!item) notFound();
  const loggedIn = !!user && user.isActive;
  const isAdmin = user?.role === "ADMIN";
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

        {/* Gated on ACTIVE as well as auth: the builder filters retired items out
            on load (receipts/new/page.tsx:17), so offering the button for one
            would hand the operator a dead end. `?items=` is the builder's
            existing contract — no new plumbing. */}
        {loggedIn && item.status === "ACTIVE" && (
          <div className="row">
            <Link className="btn btn-primary" href={`/receipts/new?items=${item.id}`}>
              Create hand receipt
            </Link>
          </div>
        )}

        {loggedIn && (
          <ItemDetailsCard
            item={{
              id: item.id,
              deviceName: item.deviceName,
              homeUnit: item.homeUnit,
              currentUser: item.currentUser,
              currentPosition: item.currentPosition,
              // ItemDetailsCard is a client component, so its props are
              // serialized into the RSC Flight payload and reach the
              // browser regardless of what the card renders. Gate the
              // value here, server-side — do NOT "simplify" this back to
              // item.notes, or a non-admin can read admin-only notes out
              // of the response even though the UI hides them.
              notes: isAdmin ? item.notes : null,
            }}
            isAdmin={isAdmin}
            units={units}
            dateLogged={formatDateTimeHST(item.createdAt)}
            loggedBy={item.createdBy ? formatParty({ isDcsim: false, name: item.createdBy.name, rank: item.createdBy.rank, unit: null }) : "—"}
            handReceiptHolder={
              currentHolder
                ? formatParty({ isDcsim: currentHolder.receiverIsDcsim, name: currentHolder.receiverName, rank: currentHolder.receiverRank, unit: currentHolder.receiverUnit })
                : "Not yet transferred"
            }
            lastEdited={lastEdit ? `${lastEdit.editedByName} · ${formatDateTimeHST(lastEdit.createdAt)}` : null}
          />
        )}

        {loggedIn && (
          <div className="card">
            <div className="card__title">Service</div>
            {service && service.status === "PENDING" ? (
              <dl className="dl">
                <dt>Status</dt>
                <dd>Needs service</dd>
                <dt>Service type</dt>
                <dd>{serviceTypeLabel(service.serviceType, service.serviceNote)}</dd>
                <dt>Hand receipt</dt>
                <dd>
                  {service.transfer
                    ? <Link href={`/receipts/${service.transfer.receiptNumber}`}><strong>{service.transfer.receiptNumber}</strong></Link>
                    : "—"}
                </dd>
              </dl>
            ) : service && service.status === "COMPLETED" ? (
              <p className="subtle">Service completed. {serviceTypeLabel(service.serviceType, service.serviceNote)}.</p>
            ) : (
              <p className="subtle">This item is not flagged for service.</p>
            )}
            {isAdmin && (
              <ServiceControls
                itemId={item.id}
                request={service ? { id: service.id, serviceType: service.serviceType, serviceNote: service.serviceNote, status: service.status } : null}
              />
            )}
          </div>
        )}

        {qr && (
          <div className="card stack-sm" style={{ textAlign: "center" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qr} alt={`QR code for ${item.make} ${item.model}`} width={220} height={220} style={{ margin: "0 auto" }} />
            <p className="subtle">Scan to view this item</p>
            <p className="qr-url">{itemUrl(item.id)}</p>
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
