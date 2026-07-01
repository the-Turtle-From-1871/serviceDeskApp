import { redirect } from "next/navigation";
import Link from "next/link";
import { listItems } from "@/modules/items/items.service";
import { requireAdmin, AuthError } from "@/lib/authz";
import { StatusBadge } from "@/components/StatusBadge";
import { toggleItemStatusAction } from "@/app/admin/actions/items";

export default async function ItemsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) redirect(e.code === "FORBIDDEN" ? "/dashboard" : "/login");
    throw e;
  }
  const { q } = await searchParams;
  const items = await listItems({ search: q });
  return (
    <div className="stack">
      <div className="row">
        <div>
          <h1 className="page-title">Items</h1>
          <p className="subtle">{items.length} item{items.length === 1 ? "" : "s"} in inventory</p>
        </div>
        <Link href="/admin/items/new" className="btn btn-primary spacer">+ New item</Link>
      </div>

      <form className="row" style={{ gap: 8 }}>
        <input
          className="input"
          name="q"
          defaultValue={q ?? ""}
          placeholder="Search make, model, serial, or asset tag"
          style={{ maxWidth: 360 }}
        />
        <button className="btn btn-secondary">Search</button>
      </form>

      {items.length === 0 ? (
        <div className="card empty">No items match your search.</div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Make</th>
                <th>Model</th>
                <th>Serial</th>
                <th>Holder</th>
                <th>Status</th>
                <th style={{ textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id}>
                  <td>{it.make}</td>
                  <td>{it.model}</td>
                  <td className="mono">{it.serialNumber}</td>
                  <td>{it.currentHolder?.name ?? <span className="subtle">Unassigned</span>}</td>
                  <td><StatusBadge status={it.status} /></td>
                  <td>
                    <div className="actions" style={{ justifyContent: "flex-end" }}>
                      <Link href={`/i/${it.id}`} className="btn btn-ghost btn-sm">View</Link>
                      <Link href={`/admin/items/${it.id}/edit`} className="btn btn-ghost btn-sm">Edit</Link>
                      <Link href={`/admin/items/${it.id}/qr`} className="btn btn-ghost btn-sm">QR</Link>
                      <form action={toggleItemStatusAction}>
                        <input type="hidden" name="id" value={it.id} />
                        <input type="hidden" name="status" value={it.status === "RETIRED" ? "ACTIVE" : "RETIRED"} />
                        <button
                          type="submit"
                          className={`btn btn-sm ${it.status === "RETIRED" ? "btn-secondary" : "btn-danger"}`}
                        >
                          {it.status === "RETIRED" ? "Reactivate" : "Retire"}
                        </button>
                      </form>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
