import Link from "next/link";
import { requireUser } from "@/lib/authz";
import { listItems } from "@/modules/items/items.service";
import { SiteHeader } from "@/components/SiteHeader";
import { ItemSelectTable } from "@/components/ItemSelectTable";
import { getLatestAuditMap } from "@/modules/audit/audit.service";
import { auditState } from "@/modules/audit/audit.status";

export default async function ItemsListPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const user = await requireUser();
  const isAdmin = user.role === "ADMIN";
  const { q } = await searchParams;
  const items = await listItems({ search: q });
  const auditMap = await getLatestAuditMap(items.map((i) => i.id));
  const now = new Date();

  return (
    <>
      <SiteHeader />
      <main className="container container-wide stack">
        <div className="row">
          <div>
            <h1 className="page-title">Items</h1>
            <p className="subtle">{items.length} item{items.length === 1 ? "" : "s"}</p>
          </div>
          {/* `spacer` (margin-left:auto) belongs on the FIRST button only. On both,
              flexbox splits the free space between them and drifts them apart
              instead of grouping them opposite the title. */}
          {isAdmin && <Link href="/admin/items/new" className="btn btn-primary spacer">+ Log new item</Link>}
          {isAdmin && <Link href="/admin/items/import" className="btn btn-secondary">Import CSV</Link>}
        </div>

        <form className="row" style={{ gap: 8 }}>
          <input className="input" name="q" defaultValue={q ?? ""} placeholder="Search device name, make, model, or serial number" style={{ maxWidth: 360 }} />
          <button className="btn btn-secondary">Search</button>
        </form>

        {items.length === 0 ? (
          <div className="card empty">No items match your search.</div>
        ) : (
          <ItemSelectTable
            items={items.map((it) => ({
              id: it.id,
              deviceName: it.deviceName,
              make: it.make,
              model: it.model,
              serialNumber: it.serialNumber,
              status: it.status,
              auditState: it.status === "RETIRED" ? null : auditState(auditMap.get(it.id) ?? null, now),
            }))}
            isAdmin={isAdmin}
          />
        )}
      </main>
    </>
  );
}
