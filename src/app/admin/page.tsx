import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAdmin, AuthError } from "@/lib/authz";
import { getTimerDashboard, type TransferTimerRow, type ServiceTimerRow } from "./dashboard/dashboard.service";
import { DueBadge } from "@/components/DueBadge";
import { getPinMeta } from "@/lib/public-access";
import { PublicAccessPinForm } from "./PublicAccessPinForm";

type TimerRow = { key: string; href: string; label: string; note: string; dueAt: string };

const toReceiptRow = (t: TransferTimerRow): TimerRow => ({
  key: t.receiptNumber,
  href: `/receipts/${t.receiptNumber}`,
  label: t.receiptNumber,
  note: t.itemSummary,
  dueAt: t.dueAt,
});

const toServiceRow = (s: ServiceTimerRow): TimerRow => ({
  key: s.itemId,
  href: `/i/${s.itemId}`,
  label: `SN ${s.serialNumber}`,
  note: s.serviceType,
  dueAt: s.dueAt,
});

function TimerList({ rows, empty, nowMs }: { rows: TimerRow[]; empty: string; nowMs: number }) {
  if (rows.length === 0) return <p className="subtle">{empty}</p>;
  return (
    <ul>
      {rows.map((r) => (
        <li key={r.key}>
          <Link href={r.href}>{r.label}</Link> — {r.note} <DueBadge dueAt={r.dueAt} now={nowMs} />
        </li>
      ))}
    </ul>
  );
}

export default async function AdminHome() {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) redirect(e.code === "FORBIDDEN" ? "/" : "/login");
    throw e;
  }

  const { overdueTransfers, soonTransfers, overdueService, soonService, nowMs } = await getTimerDashboard();
  const pinMeta = await getPinMeta();

  return (
    <div className="stack">
      <h1 className="page-title">Admin dashboard</h1>

      <section className="card stack-sm">
        <h2>Hand receipts — overdue ({overdueTransfers.length})</h2>
        <TimerList rows={overdueTransfers.map(toReceiptRow)} empty="Nothing overdue." nowMs={nowMs} />
        <h3 className="subtle">Due soon ({soonTransfers.length})</h3>
        <TimerList rows={soonTransfers.map(toReceiptRow)} empty="Nothing due soon." nowMs={nowMs} />
      </section>

      <section className="card stack-sm">
        <h2>Service items — overdue ({overdueService.length})</h2>
        <TimerList rows={overdueService.map(toServiceRow)} empty="Nothing overdue." nowMs={nowMs} />
        <h3 className="subtle">Due soon ({soonService.length})</h3>
        <TimerList rows={soonService.map(toServiceRow)} empty="Nothing due soon." nowMs={nowMs} />
        <p><Link href="/admin/queue">Open the full service queue →</Link></p>
      </section>

      {/* Admin hub: the sub-sections (Queue, Users, Audit) and the New-item
          action are reached from here rather than from separate header links,
          keeping the top nav short. Routes are unchanged and still directly
          reachable by URL. */}
      <section className="card stack-sm">
        <h2>Manage</h2>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <Link className="btn btn-secondary" href="/admin/queue">Service queue</Link>
          <Link className="btn btn-secondary" href="/admin/users">Users</Link>
          <Link className="btn btn-secondary" href="/admin/audit">Audit</Link>
          <Link className="btn btn-primary" href="/admin/items/new">+ New item</Link>
        </div>
      </section>

      <section className="card stack-sm">
        <h2>Public access PIN</h2>
        <p className="subtle">
          Logged-out visitors must enter this 8-digit PIN to search or view hand receipts and item
          records (when the gate is enabled). Rotating it stops new unlocks immediately; visitors
          already unlocked stay in for up to 7 days.
        </p>
        <p className="subtle">
          {pinMeta
            ? `Last changed ${pinMeta.updatedAt.toLocaleDateString()}${pinMeta.updatedByName ? ` by ${pinMeta.updatedByName}` : ""}.`
            : "No PIN set yet."}
        </p>
        <PublicAccessPinForm />
      </section>
    </div>
  );
}
