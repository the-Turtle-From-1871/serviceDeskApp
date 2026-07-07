import Link from "next/link";
import { requireUser } from "@/lib/authz";
import { listItems } from "@/modules/items/items.service";
import { SiteHeader } from "@/components/SiteHeader";
import { ItemSelectTable } from "@/components/ItemSelectTable";

export default async function ItemsListPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const user = await requireUser();
  const isAdmin = user.role === "ADMIN";
  const { q } = await searchParams;
  const items = await listItems({ search: q });

  return (
    <>
      <SiteHeader />
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
          <ItemSelectTable
            items={items.map((it) => ({ id: it.id, make: it.make, model: it.model, serialNumber: it.serialNumber, status: it.status }))}
            isAdmin={isAdmin}
          />
        )}
      </main>
    </>
  );
}
