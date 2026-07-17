import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAdmin, AuthError } from "@/lib/authz";
import { getTimerDashboard } from "./dashboard/dashboard.service";
import { DueBadge } from "@/components/DueBadge";

export default async function AdminHome() {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) redirect(e.code === "FORBIDDEN" ? "/" : "/login");
    throw e;
  }

  const now = Date.now();
  const { overdueTransfers, soonTransfers, overdueService, soonService } = await getTimerDashboard(new Date(now));

  return (
    <div className="stack">
      <h1 className="page-title">Admin dashboard</h1>

      <section className="card stack-sm">
        <h2>Hand receipts — overdue ({overdueTransfers.length})</h2>
        {overdueTransfers.length === 0 ? <p className="subtle">Nothing overdue.</p> : (
          <ul>
            {overdueTransfers.map((t) => (
              <li key={t.receiptNumber}>
                <Link href={`/receipts/${t.receiptNumber}`}>{t.receiptNumber}</Link> — {t.itemSummary}{" "}
                <DueBadge dueAt={t.dueAt} now={now} />
              </li>
            ))}
          </ul>
        )}
        <h3 className="subtle">Due soon ({soonTransfers.length})</h3>
        <ul>
          {soonTransfers.map((t) => (
            <li key={t.receiptNumber}>
              <Link href={`/receipts/${t.receiptNumber}`}>{t.receiptNumber}</Link> — {t.itemSummary}{" "}
              <DueBadge dueAt={t.dueAt} now={now} />
            </li>
          ))}
        </ul>
      </section>

      <section className="card stack-sm">
        <h2>Service items — overdue ({overdueService.length})</h2>
        {overdueService.length === 0 ? <p className="subtle">Nothing overdue.</p> : (
          <ul>
            {overdueService.map((s) => (
              <li key={s.itemId}>
                <Link href={`/i/${s.itemId}`}>SN {s.serialNumber}</Link> — {s.serviceType}{" "}
                <DueBadge dueAt={s.dueAt} now={now} />
              </li>
            ))}
          </ul>
        )}
        <h3 className="subtle">Due soon ({soonService.length})</h3>
        <ul>
          {soonService.map((s) => (
            <li key={s.itemId}>
              <Link href={`/i/${s.itemId}`}>SN {s.serialNumber}</Link> — {s.serviceType}{" "}
              <DueBadge dueAt={s.dueAt} now={now} />
            </li>
          ))}
        </ul>
        <p><Link href="/admin/queue">Open the full service queue →</Link></p>
      </section>
    </div>
  );
}
