import { redirect } from "next/navigation";
import Link from "next/link";
import prisma from "@/lib/prisma";
import { requireAdmin, AuthError } from "@/lib/authz";
import { StatusBadge } from "@/components/StatusBadge";
import { formatDateTimeHST } from "@/lib/datetime";
import { formatParty } from "@/modules/transfers/party";

export default async function AuditPage() {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) redirect(e.code === "FORBIDDEN" ? "/" : "/login");
    throw e;
  }
  const transfers = await prisma.transfer.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
  const imports = await prisma.importBatch.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { createdBy: { select: { name: true } } },
  });
  const returns = await prisma.returnTransaction.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  const itemEdits = await prisma.itemEdit.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { item: { select: { id: true, serialNumber: true, deviceName: true } } },
  });
  return (
    <div className="stack">
      <div>
        <h1 className="page-title">Audit log</h1>
        <p className="subtle">Every hand receipt across all items — {transfers.length} shown.</p>
      </div>
      {imports.length > 0 && (
        <div className="stack-sm">
          <h2 className="card__title">CSV imports</h2>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Date</th><th>By</th><th>File</th><th>Added</th><th>Skipped</th></tr>
              </thead>
              <tbody>
                {imports.map((b) => {
                  const skipped = (b.skipped as { serialNumber: string; reason: string }[]) ?? [];
                  return (
                    <tr key={b.id}>
                      <td className="subtle" data-label="Date">{formatDateTimeHST(b.createdAt)}</td>
                      <td data-label="By">{b.createdBy.name}</td>
                      <td data-label="File">{b.filename}</td>
                      <td data-label="Added">{b.addedCount}</td>
                      <td data-label="Skipped">
                        {b.skippedCount}
                        {skipped.length > 0 && <span className="subtle"> ({skipped.map((s) => s.serialNumber || "?").join(", ")})</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {returns.length > 0 && (
        <div className="stack-sm">
          <h2 className="card__title">Property returns</h2>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Date</th><th>By</th><th>Receipt</th><th>Kind</th><th>Returned</th><th>Remaining</th></tr>
              </thead>
              <tbody>
                {returns.map((r) => {
                  const items = Array.isArray(r.returned) ? (r.returned as { serialNumber: string }[]) : [];
                  return (
                    <tr key={r.id}>
                      <td className="subtle" data-label="Date">{formatDateTimeHST(r.createdAt)}</td>
                      <td data-label="By">{r.processedByName}</td>
                      <td data-label="Receipt"><Link href={`/receipts/${r.receiptNumber}`}>{r.receiptNumber}</Link></td>
                      <td data-label="Kind">{r.kind}</td>
                      <td data-label="Returned">
                        {r.returnedCount}
                        {items.length > 0 && <span className="subtle"> ({items.map((i) => i.serialNumber || "?").join(", ")})</span>}
                      </td>
                      <td data-label="Remaining">{r.remainingCount}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {itemEdits.length > 0 && (
        <div className="stack-sm">
          <h2 className="card__title">Item edits</h2>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Date</th><th>By</th><th>Item</th><th>Changed</th></tr>
              </thead>
              <tbody>
                {itemEdits.map((e) => {
                  const changes = Array.isArray(e.changes)
                    ? (e.changes as unknown as { field: string; from: string | null; to: string | null }[])
                    : [];
                  return (
                    <tr key={e.id}>
                      <td className="subtle" data-label="Date">{formatDateTimeHST(e.createdAt)}</td>
                      <td data-label="By">{e.editedByName}</td>
                      <td data-label="Item">
                        <Link href={`/i/${e.item.id}`}>{e.item.deviceName || e.item.serialNumber}</Link>
                      </td>
                      <td data-label="Changed">
                        {changes.map((c) => (
                          <div key={c.field} className="subtle">
                            {c.field}: {c.from ?? "—"} → {c.to ?? "—"}
                          </div>
                        ))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
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
                <td data-label="From">{formatParty({ isDcsim: t.senderIsDcsim, name: t.senderName, rank: t.senderRank, unit: t.senderUnit })}</td>
                <td data-label="To">{formatParty({ isDcsim: t.receiverIsDcsim, name: t.receiverName, rank: t.receiverRank, unit: t.receiverUnit })}</td>
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
