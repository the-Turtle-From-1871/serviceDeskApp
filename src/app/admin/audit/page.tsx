import { redirect } from "next/navigation";
import Link from "next/link";
import prisma from "@/lib/prisma";
import { requireAdmin, AuthError } from "@/lib/authz";
import { StatusBadge } from "@/components/StatusBadge";
import { formatDateTimeHST } from "@/lib/datetime";

function partyLabel(isDcsim: boolean, name: string, rank: string | null): string {
  if (isDcsim) return `DCSIM · ${name}`;
  return rank ? `${rank} ${name}` : name;
}

export default async function AuditPage() {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) redirect(e.code === "FORBIDDEN" ? "/" : "/login");
    throw e;
  }
  const transfers = await prisma.transfer.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
  return (
    <div className="stack">
      <div>
        <h1 className="page-title">Audit log</h1>
        <p className="subtle">Every hand receipt across all items — {transfers.length} shown.</p>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Receipt</th>
              <th>Item</th>
              <th>From</th>
              <th>To</th>
              <th>Date</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {transfers.map((t) => (
              <tr key={t.id}>
                <td data-label="Receipt"><Link href={`/receipts/${t.receiptNumber}`}>{t.receiptNumber}</Link></td>
                <td data-label="Item">{t.itemSummary}</td>
                <td data-label="From">{partyLabel(t.senderIsDcsim, t.senderName, t.senderRank)}</td>
                <td data-label="To">{partyLabel(t.receiverIsDcsim, t.receiverName, t.receiverRank)}</td>
                <td className="subtle" data-label="Date">{formatDateTimeHST(t.createdAt)}</td>
                <td data-label="Status"><StatusBadge status={t.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
