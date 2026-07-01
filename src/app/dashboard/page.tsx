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
    <main style={{ fontFamily: "system-ui", maxWidth: 720, margin: "2rem auto" }}>
      <header style={{ display: "flex", justifyContent: "space-between" }}>
        <h1>Hello, {user.name}</h1><SignOutButton />
      </header>

      <section>
        <h2>Action needed — incoming</h2>
        {pending.incoming.length === 0 ? <p>Nothing to sign.</p> : (
          <ul>{pending.incoming.map((t) => (
            <li key={t.id}><Link href={`/transfers/${t.id}`}>Sign for {t.itemSummary}</Link> (from {t.fromUserName ?? "—"})</li>
          ))}</ul>
        )}
      </section>

      <section>
        <h2>Awaiting the other party — outgoing</h2>
        {pending.outgoing.length === 0 ? <p>No pending sends.</p> : (
          <ul>{pending.outgoing.map((t) => (
            <li key={t.id}><Link href={`/transfers/${t.id}`}>{t.itemSummary}</Link> → {t.toUserName} (pending)</li>
          ))}</ul>
        )}
      </section>

      <section>
        <h2>Items I hold</h2>
        {held.length === 0 ? <p>You are not holding any items.</p> : (
          <ul>{held.map((it) => (
            <li key={it.id}><Link href={`/i/${it.id}`}>{it.make} {it.model} (SN {it.serialNumber})</Link></li>
          ))}</ul>
        )}
      </section>
    </main>
  );
}
