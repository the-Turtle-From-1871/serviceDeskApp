import Link from "next/link";
import { notFound } from "next/navigation";
import { getTransferByReceiptNumber } from "@/modules/transfers/transfers.service";
import { formatDateTimeHST } from "@/lib/datetime";
import { SiteHeader } from "@/components/SiteHeader";

function partyLine(p: { isDcsim: boolean; name: string; rank: string | null; unit: string | null }): string {
  if (p.isDcsim) return `DCSIM · ${p.name}`;
  const head = p.rank ? `${p.rank} ${p.name}` : p.name;
  return p.unit ? `${head} (${p.unit})` : head;
}

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
          <div><strong>Item:</strong> {t.item.make} {t.item.model} (SN {t.item.serialNumber})</div>
          <div><strong>From:</strong> {partyLine({ isDcsim: t.senderIsDcsim, name: t.senderName, rank: t.senderRank, unit: t.senderUnit })}</div>
          <div><strong>To:</strong> {partyLine({ isDcsim: t.receiverIsDcsim, name: t.receiverName, rank: t.receiverRank, unit: t.receiverUnit })}</div>
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
