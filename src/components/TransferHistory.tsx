import Link from "next/link";
import { StatusBadge } from "@/components/StatusBadge";
import { formatDateTimeHST } from "@/lib/datetime";

type Row = {
  id: string;
  receiptNumber: string;
  status: string;
  senderIsDcsim: boolean;
  senderName: string;
  senderRank: string | null;
  receiverIsDcsim: boolean;
  receiverName: string;
  receiverRank: string | null;
  createdAt: Date;
};

function partyLabel(isDcsim: boolean, name: string, rank: string | null): string {
  if (isDcsim) return `DCSIM · ${name}`;
  return rank ? `${rank} ${name}` : name;
}

export function TransferHistory({ rows }: { rows: Row[] }) {
  if (rows.length === 0) return <p className="empty">No transfers yet.</p>;
  return (
    <ul className="timeline">
      {rows.map((r) => (
        <li key={r.id}>
          <div className="row" style={{ gap: 8 }}>
            <span className="who">
              {partyLabel(r.senderIsDcsim, r.senderName, r.senderRank)} → {partyLabel(r.receiverIsDcsim, r.receiverName, r.receiverRank)}
            </span>
            <StatusBadge status={r.status} />
            <Link href={`/receipts/${r.receiptNumber}`} className="btn btn-ghost btn-sm spacer">
              Hand receipt ({r.receiptNumber})
            </Link>
          </div>
          <div className="meta">{formatDateTimeHST(r.createdAt)}</div>
        </li>
      ))}
    </ul>
  );
}
