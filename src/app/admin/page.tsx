import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAdmin, AuthError } from "@/lib/authz";
import {
  getTimerDashboard,
  getRecentReceipts,
  type TransferTimerRow,
  type ServiceTimerRow,
  type RecentReceiptRow,
} from "./dashboard/dashboard.service";
import { DueBadge } from "@/components/DueBadge";
import { getPinMeta } from "@/lib/public-access";
import { countOpenRequests } from "@/modules/users/permissions.service";
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

function RecentReceiptList({ rows }: { rows: RecentReceiptRow[] }) {
  if (rows.length === 0) return <p className="subtle">No hand receipts yet.</p>;
  return (
    <ul>
      {rows.map((r) => (
        <li key={r.receiptNumber}>
          <Link href={`/receipts/${r.receiptNumber}`}>{r.receiptNumber}</Link> — {r.itemSummary}{" "}
          <span className="subtle">
            to {r.receiverName} · {new Date(r.createdAt).toLocaleDateString()}
          </span>{" "}
          <span className={`badge ${r.status === "OPEN" ? "badge-open" : "badge-closed"}`}>
            {r.status === "OPEN" ? "Open" : "Closed"}
          </span>
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

  const [timers, recentReceipts, pinMeta, openRequests] = await Promise.all([
    getTimerDashboard(),
    getRecentReceipts(),
    getPinMeta(),
    countOpenRequests(),
  ]);
  const { overdueTransfers, soonTransfers, overdueService, soonService, nowMs } = timers;

  return (
    <div className="stack">
      <h1 className="page-title">Admin dashboard</h1>

      <section className="card stack-sm">
        <h2>Hand receipts — overdue ({overdueTransfers.length})</h2>
        <TimerList rows={overdueTransfers.map(toReceiptRow)} empty="Nothing overdue." nowMs={nowMs} />
        <h3 className="subtle">Due soon ({soonTransfers.length})</h3>
        <TimerList rows={soonTransfers.map(toReceiptRow)} empty="Nothing due soon." nowMs={nowMs} />
      </section>

      {/* Recency, not accountability: the timer lists above answer "what's due",
          this answers "what did we just issue". Closed receipts are purged 90
          days after closing, so the window is bounded by that. */}
      <section className="card stack-sm">
        <h2>Recent hand receipts</h2>
        <RecentReceiptList rows={recentReceipts} />
        <p><Link href="/receipts/new">Create a hand receipt →</Link></p>
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
          <Link className="btn btn-secondary" href="/admin/analytics">Readiness analytics</Link>
          <Link className="btn btn-secondary" href="/admin/categories">Device categories</Link>
          <Link className="btn btn-secondary" href="/admin/units">Units</Link>
          <Link className="btn btn-secondary" href="/admin/queue">Service queue</Link>
          <Link className="btn btn-secondary" href="/admin/users">Users</Link>
          <Link className="btn btn-secondary" href="/admin/audit">Audit</Link>
          {/* Carries the pending count so a waiting request is visible without
              opening the page. Not a nav-rail tab — admins are already at the
              five-tab budget (see navItemsFor). */}
          <Link className="btn btn-secondary" href="/admin/permissions">
            Permission requests{openRequests > 0 ? ` (${openRequests})` : ""}
          </Link>
          <Link className="btn btn-secondary" href="/receipts">Hand receipts</Link>
          {/* An admin has no Receipts rail tab — a sixth truncates labels at
              375px — so the hub is how they reach the list. See navItemsFor. */}
          <Link className="btn btn-secondary" href="/receipts">Hand receipts</Link>
          <Link className="btn btn-primary" href="/admin/items/new">+ New item</Link>
        </div>
      </section>

      <section className="card stack-sm">
        <h2>Public access PIN</h2>
        <p className="subtle">
          Logged-out visitors must enter this 8-digit PIN to search or view hand receipts and item
          records (when the gate is enabled). Rotating it stops new unlocks immediately; visitors
          already unlocked stay in for up to 12 hours.
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
