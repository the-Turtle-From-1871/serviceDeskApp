import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser, AuthError } from "@/lib/authz";
import { getHeldItems, getPendingForUser } from "@/modules/transfers/transfers.service";
import { SignOutButton } from "@/components/SignOutButton";

export default async function Dashboard() {
  let user;
  try { user = await requireUser(); }
  catch (e) { if (e instanceof AuthError) redirect("/login"); throw e; }

  const [held, pending] = await Promise.all([getHeldItems(user.id), getPendingForUser(user.id)]);

  return (
    <>
      <header className="app-header">
        <div className="app-header__inner">
          <Link href="/dashboard" className="brand">
            <span className="brand__mark">HR</span>
            Hand Receipt
          </Link>
          <span className="spacer" />
          <span className="subtle" style={{ marginRight: 4 }}>{user.name}</span>
          <SignOutButton />
        </div>
      </header>

      <main className="container container-mid stack">
        <div>
          <h1 className="page-title">Hello, {user.name}</h1>
          <p className="subtle">Sign for incoming items and manage what you hold.</p>
        </div>

        <div className="card">
          <div className="card__title">Action needed — incoming</div>
          {pending.incoming.length === 0 ? (
            <p className="empty">Nothing to sign right now.</p>
          ) : (
            <ul className="list">
              {pending.incoming.map((t) => (
                <li key={t.id} className="row">
                  <div>
                    <div><strong>{t.itemSummary}</strong></div>
                    <div className="subtle">from {t.fromUserName ?? "—"}</div>
                  </div>
                  <Link href={`/transfers/${t.id}`} className="btn btn-primary btn-sm spacer">Review &amp; sign</Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card">
          <div className="card__title">Awaiting the other party — outgoing</div>
          {pending.outgoing.length === 0 ? (
            <p className="empty">No pending sends.</p>
          ) : (
            <ul className="list">
              {pending.outgoing.map((t) => (
                <li key={t.id} className="row">
                  <div>
                    <div><strong>{t.itemSummary}</strong></div>
                    <div className="subtle">to {t.toUserName} · awaiting signature</div>
                  </div>
                  <Link href={`/transfers/${t.id}`} className="btn btn-ghost btn-sm spacer">View</Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card">
          <div className="card__title">Items I hold</div>
          {held.length === 0 ? (
            <p className="empty">You are not holding any items.</p>
          ) : (
            <ul className="list">
              {held.map((it) => (
                <li key={it.id} className="row">
                  <div>
                    <div><strong>{it.make} {it.model}</strong></div>
                    <div className="subtle mono">SN {it.serialNumber}</div>
                  </div>
                  <Link href={`/i/${it.id}`} className="btn btn-ghost btn-sm spacer">Open</Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>
    </>
  );
}
