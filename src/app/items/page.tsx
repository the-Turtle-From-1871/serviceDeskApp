import Link from "next/link";
import { requireUser } from "@/lib/authz";
import { listItems, listItemUics } from "@/modules/items/items.service";
import { SiteHeader } from "@/components/SiteHeader";
import { ItemSelectTable } from "@/components/ItemSelectTable";
import { ItemsSearchInput } from "./ItemsSearchInput";
import { auditState } from "@/modules/audit/audit.status";
import { firstParam } from "@/lib/search-params";

export default async function ItemsListPage({
  searchParams,
}: {
  // string[] is reachable: Next supplies an array whenever a key is repeated
  // (`?uic=A&uic=B`). firstParam collapses that before any string method runs.
  searchParams: Promise<{
    q?: string | string[];
    sort?: string | string[];
    dir?: string | string[];
    page?: string | string[];
    uic?: string | string[];
    group?: string | string[];
  }>;
}) {
  const user = await requireUser();
  const isAdmin = user.role === "ADMIN";
  const sp = await searchParams;
  const q = firstParam(sp.q);
  const pageParam = firstParam(sp.page);

  // Server-side paginate + sort: only the current page is fetched and serialized to
  // the client (the list was previously unbounded). The audit-status badge and the
  // audit-status sort both read the denormalized Item.lastAuditedAt column.
  // Two queries, both bounded: the page of rows, and the UIC filter's options.
  const [result, uics] = await Promise.all([
    listItems({
      search: q,
      sort: firstParam(sp.sort) ?? null,
      dir: firstParam(sp.dir) ?? null,
      page: pageParam ? Number.parseInt(pageParam, 10) : 1,
      uic: firstParam(sp.uic) ?? null,
      group: firstParam(sp.group) ?? null,
    }),
    listItemUics(),
  ]);
  const now = new Date();
  const totalPages = Math.max(1, Math.ceil(result.total / result.pageSize));

  return (
    <>
      <SiteHeader />
      <main className="container container-wide stack">
        <div className="row">
          <div>
            <h1 className="page-title">Items</h1>
            <p className="subtle">{result.total} item{result.total === 1 ? "" : "s"}</p>
          </div>
          {/* `spacer` (margin-left:auto) belongs on the FIRST button only. On both,
              flexbox splits the free space between them and drifts them apart
              instead of grouping them opposite the title. */}
          {isAdmin && <Link href="/admin/items/new" className="btn btn-primary spacer">+ Log new item</Link>}
          {isAdmin && <Link href="/admin/items/import" className="btn btn-secondary">Import CSV</Link>}
        </div>

        <ItemsSearchInput
          q={q ?? ""}
          sortKeys={result.sortKeys}
          uic={result.uic}
          grouped={result.grouped}
        />

        {/* ItemSelectTable renders even with zero rows, because it OWNS the
            filter/sort/grouping controls. Swapping it for an empty-state card
            (as this used to) removed the very controls needed to undo the
            filter that emptied the list — leaving the URL as the only way out.
            The empty message now lives inside the table instead. */}
        <ItemSelectTable
          items={result.items.map((it) => ({
              id: it.id,
              deviceName: it.deviceName,
              make: it.make,
              model: it.model,
              serialNumber: it.serialNumber,
              status: it.status,
              auditState: it.status === "RETIRED" ? null : auditState(it.lastAuditedAt, now),
              deviceUIC: it.deviceUIC,
              deviceCategory: it.deviceCategory,
              deployableStatus: it.deployableStatus,
              isAccountedFor: it.isAccountedFor,
            }))}
            isAdmin={isAdmin}
            q={q ?? ""}
            sort={result.sort}
            dir={result.dir}
            page={result.page}
            totalPages={totalPages}
            sortKeys={result.sortKeys}
            grouped={result.grouped}
            uic={result.uic}
            uics={uics}
          />
      </main>
    </>
  );
}
