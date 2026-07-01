import { redirect } from "next/navigation";
import Link from "next/link";
import prisma from "@/lib/prisma";
import { requireAdmin, AuthError } from "@/lib/authz";

export default async function AuditPage() {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) redirect(e.code === "FORBIDDEN" ? "/dashboard" : "/login");
    throw e;
  }
  const transfers = await prisma.transfer.findMany({ orderBy: { initiatedAt: "desc" }, take: 200 });
  return (
    <div>
      <h1>Audit — all transfers</h1>
      <table>
        <thead><tr><th>Item</th><th>From</th><th>To</th><th>Status</th><th>Override</th><th>Initiated</th><th>Signed</th></tr></thead>
        <tbody>
          {transfers.map((t) => (
            <tr key={t.id}>
              <td><Link href={`/i/${t.itemId}`}>{t.itemSummary}</Link></td>
              <td>{t.fromUserName ?? "—"}</td><td>{t.toUserName}</td>
              <td>{t.status}</td><td>{t.isOverride ? "Yes" : ""}</td>
              <td>{new Date(t.initiatedAt).toLocaleString()}</td>
              <td>{t.signedAt ? new Date(t.signedAt).toLocaleString() : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
