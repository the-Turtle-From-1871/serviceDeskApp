import Link from "next/link";
import { requireUser } from "@/lib/authz";
import { listItems } from "@/modules/items/items.service";
import { StatusBadge } from "@/components/StatusBadge";
import { SignOutButton } from "@/components/SignOutButton";
import { toggleItemStatusAction } from "@/app/admin/actions/items";
import { AppHeader } from "@/components/AppHeader";

export default async function ItemsListPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const user = await requireUser();
  const isAdmin = user.role === "ADMIN";
  const { q } = await searchParams;
  const items = await listItems({ search: q });

  return (
    <>
      <AppHeader brandHref="/">
        {isAdmin && <Link href="/admin/items/new" className="btn btn-ghost btn-sm">Log new item</Link>}
        {isAdmin && <Link href="/admin/users" className="btn btn-ghost btn-sm">Users</Link>}
        {isAdmin && <Link href="/admin/audit" className="btn btn-ghost btn-sm">Audit</Link>}
        <SignOutButton />
      </AppHeader>
      <main className="container stack">
        <div className="row">
          <div>
            <h1 className="page-title">Items</h1>
            <p className="subtle">{items.length} item{items.length === 1 ? "" : "s"}</p>
          </div>
          {isAdmin && <Link href="/admin/items/new" className="btn btn-primary spacer">+ Log new item</Link>}
        </div>

        <form className="row" style={{ gap: 8 }}>
          <input className="input" name="q" defaultValue={q ?? ""} placeholder="Search make, model, or serial number" style={{ maxWidth: 360 }} />
          <button className="btn btn-secondary">Search</button>
        </form>

        {items.length === 0 ? (
          <div className="card empty">No items match your search.</div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Make</th><th>Model</th><th>Serial</th><th>Status</th><th style={{ textAlign: "right" }}>Actions</th></tr>
              </thead>
              <tbody>
                {items.map((it) => (
                  <tr key={it.id}>
                    <td data-label="Make">{it.make}</td>
                    <td data-label="Model">{it.model}</td>
                    <td className="mono" data-label="Serial">{it.serialNumber}</td>
                    <td data-label="Status"><StatusBadge status={it.status} /></td>
                    <td data-label="">
                      <div className="actions" style={{ justifyContent: "flex-end" }}>
                        <Link href={`/i/${it.id}`} className="btn btn-ghost btn-sm">View</Link>
                        {it.status === "ACTIVE" && <Link href={`/items/${it.id}/transfer`} className="btn btn-primary btn-sm">Transfer</Link>}
                        {isAdmin && <Link href={`/admin/items/${it.id}/qr`} className="btn btn-ghost btn-sm">QR</Link>}
                        {isAdmin && <Link href={`/admin/items/${it.id}/edit`} className="btn btn-ghost btn-sm">Edit</Link>}
                        {isAdmin && (
                          <form action={toggleItemStatusAction}>
                            <input type="hidden" name="id" value={it.id} />
                            <input type="hidden" name="status" value={it.status === "RETIRED" ? "ACTIVE" : "RETIRED"} />
                            <button type="submit" className={`btn btn-sm ${it.status === "RETIRED" ? "btn-secondary" : "btn-danger"}`}>
                              {it.status === "RETIRED" ? "Reactivate" : "Retire"}
                            </button>
                          </form>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </>
  );
}
