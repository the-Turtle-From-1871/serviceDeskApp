import Link from "next/link";
import { notFound } from "next/navigation";
import { getTransferByReceiptNumber } from "@/modules/transfers/transfers.service";
import { getClosingReturn } from "@/modules/returns/returns.service";
import { formatParty } from "@/modules/transfers/party";
import { formatDateTimeHST } from "@/lib/datetime";
import { SiteHeader } from "@/components/SiteHeader";
import { getCurrentUser } from "@/lib/session";
import { NotifyPickupButton } from "./NotifyPickupButton";

export default async function ReceiptPage({ params }: { params: Promise<{ receiptNumber: string }> }) {
  const { receiptNumber } = await params;
  const t = await getTransferByReceiptNumber(receiptNumber);
  if (!t) notFound();

  const me = await getCurrentUser();
  const isAdmin = me?.role === "ADMIN";
  const isStaff = !!me && me.isActive;
  const closed = t.status === "CLOSED";
  // The customer is the non-DCSIM party (receiver first). Staff can notify on an
  // open receipt; the button itself is disabled (with a reason) when the customer
  // has no email, so the option is always visible rather than silently missing.
  const customerEmail = !t.receiverIsDcsim ? t.receiverEmail : !t.senderIsDcsim ? t.senderEmail : null;
  const showNotify = isStaff && !closed;
  const closing = closed ? await getClosingReturn(t.id) : null;

  return (
    <>
      <SiteHeader />
      <main className="container container-mid stack">
        <h1 className="page-title">Hand receipt {t.receiptNumber}</h1>

        {closed && (
          <div className="card alert-error" role="status">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
              <div style={{ flex: "1 1 240px", minWidth: 0 }}><strong>CLOSED</strong> — all equipment returned. This receipt is closed and read-only.</div>
              {closing && (
                <div style={{ flex: "0 0 auto", textAlign: "right" }}>
                  <div><strong>{closing.processedByName}</strong></div>
                  {closing.processedBySignature && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={closing.processedBySignature} alt={`Signature of ${closing.processedByName}`} className="sig-preview" style={{ maxWidth: 150, maxHeight: 56 }} />
                  )}
                  <div><strong>{formatDateTimeHST(closing.createdAt)}</strong></div>
                </div>
              )}
            </div>
          </div>
        )}

        <div className="card stack-sm">
          <div>
            <strong>Items:</strong>
            <ul>
              {t.lines.map((ln) => {
                const total = ln.items.length;
                const held = ln.items.filter((it) => it.returnedAt === null).length;
                const partiallyReturned = held < total;
                return (
                  <li key={ln.id}>
                    {ln.make} {ln.model} — auth {ln.qtyAuth} / issued {ln.qtyIssued} {ln.unitOfIssue}
                    {" "}(SN {ln.items.map((it) => it.serialNumber).join(", ")})
                    {partiallyReturned && (
                      <>
                        {" — held: "}
                        <s className="subtle">{total}</s> <strong>{held}</strong>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
          <div><strong>From:</strong> {formatParty({ isDcsim: t.senderIsDcsim, name: t.senderName, rank: t.senderRank, unit: t.senderUnit })}</div>
          <div><strong>To:</strong> {formatParty({ isDcsim: t.receiverIsDcsim, name: t.receiverName, rank: t.receiverRank, unit: t.receiverUnit })}</div>
          <div><strong>Date:</strong> {formatDateTimeHST(t.createdAt)}</div>
          <div><strong>Status:</strong> {t.status}</div>
        </div>

        {((isAdmin && !closed) || showNotify) && (
          <div className="row">
            {isAdmin && !closed && (
              <a className="btn btn-primary" href={`/receipts/${t.receiptNumber}/return`}>Process return</a>
            )}
            {showNotify && <NotifyPickupButton receiptNumber={t.receiptNumber} hasCustomerEmail={!!customerEmail} />}
          </div>
        )}
        <div className="row">
          <a className="btn btn-secondary" href={`/receipts/${t.receiptNumber}/pdf?preview=1`} target="_blank" rel="noopener noreferrer">Preview PDF</a>
          <a className="btn btn-secondary" href={`/receipts/${t.receiptNumber}/pdf`}>Download PDF</a>
          <Link className="btn btn-ghost" href="/">Search another</Link>
        </div>
      </main>
    </>
  );
}
