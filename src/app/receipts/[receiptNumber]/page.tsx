import Link from "next/link";
import { notFound } from "next/navigation";
import { getTransferByReceiptNumber } from "@/modules/transfers/transfers.service";
import { formatParty } from "@/modules/transfers/party";
import { formatDateTimeHST } from "@/lib/datetime";
import { SiteHeader } from "@/components/SiteHeader";

export default async function ReceiptPage({ params }: { params: Promise<{ receiptNumber: string }> }) {
  const { receiptNumber } = await params;
  const t = await getTransferByReceiptNumber(receiptNumber);
  if (!t) notFound();

  return (
    <>
      <SiteHeader />
      <main className="container container-mid stack">
        <h1 className="page-title">Hand receipt {t.receiptNumber}</h1>
        <div className="card stack-sm">
          <div>
            <strong>Items:</strong>
            <ul>
              {t.lines.map((ln) => (
                <li key={ln.id}>
                  {ln.make} {ln.model} — auth {ln.qtyAuth} / issued {ln.qtyIssued} {ln.unitOfIssue}
                  {" "}(SN {ln.items.map((it) => it.serialNumber).join(", ")})
                </li>
              ))}
            </ul>
          </div>
          <div><strong>From:</strong> {formatParty({ isDcsim: t.senderIsDcsim, name: t.senderName, rank: t.senderRank, unit: t.senderUnit })}</div>
          <div><strong>To:</strong> {formatParty({ isDcsim: t.receiverIsDcsim, name: t.receiverName, rank: t.receiverRank, unit: t.receiverUnit })}</div>
          <div><strong>Date:</strong> {formatDateTimeHST(t.createdAt)}</div>
        </div>
        <div className="row">
          <a className="btn btn-primary" href={`/receipts/${t.receiptNumber}/pdf`}>Download PDF</a>
          <Link className="btn btn-ghost" href="/">Search another</Link>
        </div>
      </main>
    </>
  );
}
