import { redirect } from "next/navigation";
import Link from "next/link";
import prisma from "@/lib/prisma";
import { requireAdmin, AuthError } from "@/lib/authz";
import { StatusBadge } from "@/components/StatusBadge";

export default async function AuditPage() {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) redirect(e.code === "FORBIDDEN" ? "/dashboard" : "/login");
    throw e;
  }
  const transfers = await prisma.transfer.findMany({ orderBy: { initiatedAt: "desc" }, take: 200 });
  return (
    <div className="stack">
      <div>
        <h1 className="page-title">Audit log</h1>
        <p className="subtle">Every transfer across all items — most recent {transfers.length} shown.</p>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Item</th>
              <th>From</th>
              <th>To</th>
              <th>Status</th>
              <th>Initiated</th>
              <th>Signed</th>
            </tr>
          </thead>
          <tbody>
            {transfers.map((t) => (
              <tr key={t.id}>
                <td><Link href={`/i/${t.itemId}`}>{t.itemSummary}</Link></td>
                <td>{t.fromUserName ?? <span className="subtle">—</span>}</td>
                <td>{t.toUserName}</td>
                <td>
                  <div className="row" style={{ gap: 6 }}>
                    <StatusBadge status={t.status} />
                    {t.isOverride && <span className="badge badge-override">Override</span>}
                  </div>
                </td>
                <td className="subtle">{new Date(t.initiatedAt).toLocaleString()}</td>
                <td className="subtle">{t.signedAt ? new Date(t.signedAt).toLocaleString() : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
