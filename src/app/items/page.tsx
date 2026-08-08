import Link from "next/link";
import { requireUser } from "@/lib/authz";
import { listItems, listItemUics } from "@/modules/items/items.service";
import { listCategoryNames } from "@/modules/items/categories.service";
import { readinessForItems } from "@/modules/items/readiness.query";
import { holdersForItems } from "@/modules/transfers/holders.query";
import { SiteHeader } from "@/components/SiteHeader";
import { ItemSelectTable } from "@/components/ItemSelectTable";
import { ItemsSearchInput } from "./ItemsSearchInput";
import { ItemsScanButton } from "./ItemsScanButton";
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
  // Three queries, all bounded and all independent of page size: the page of rows,
  // the UIC filter's options, and — for admins only — the managed category
  // vocabulary that backs the bulk "Change category" control. The vocabulary is a
  // small curated list fetched ONCE per render, never per row. A standard USER
  // never sees those controls, so they never pay for the query.
  const [result, uics, categoryNames] = await Promise.all([
    listItems({
      search: q,
      sort: firstParam(sp.sort) ?? null,
      dir: firstParam(sp.dir) ?? null,
      page: pageParam ? Number.parseInt(pageParam, 10) : 1,
      uic: firstParam(sp.uic) ?? null,
    }),
    listItemUics(),
    isAdmin ? listCategoryNames() : Promise.resolve<string[]>([]),
  ]);
  // Neither readiness nor the current holder can ride along on the item row —
  // both are derived from other tables. TWO extra queries derive them for the
  // whole page at once, never one per row, and both must follow listItems
  // because they need the page's ids. Bounded by ITEMS_PAGE_SIZE.
  const ids = result.items.map((it) => it.id);
  const [readiness, holders] = await Promise.all([
    readinessForItems(ids),
    holdersForItems(ids),
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

        {/* The scan button sits with the search box because it does the same
            job by other means: both narrow the list to one device. */}
        <div className="row" style={{ gap: 8, alignItems: "flex-start" }}>
          <ItemsSearchInput
            q={q ?? ""}
            sortKeys={result.sortKeys}
            uic={result.uic}
          />
          <ItemsScanButton />
        </div>

        {/* ItemSelectTable renders even with zero rows, because it OWNS the
            filter/sort controls. Swapping it for an empty-state card
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
              // Absent from the map = nothing currently holds it.
              holderName: holders.get(it.id) ?? null,
              status: it.status,
              auditState: it.status === "RETIRED" ? null : auditState(it.lastAuditedAt, now),
              deviceUIC: it.deviceUIC,
              deviceCategory: it.deviceCategory,
              // A row that vanished between the two queries falls back to
              // "we know nothing about it" rather than dropping the row.
              readiness: readiness.get(it.id) ?? "UNTRIAGED",
            }))}
            isAdmin={isAdmin}
            q={q ?? ""}
            sort={result.sort}
            dir={result.dir}
            page={result.page}
            totalPages={totalPages}
            sortKeys={result.sortKeys}
            uic={result.uic}
            uics={uics}
            categories={categoryNames.map((name) => ({ name }))}
          />
      </main>
    </>
  );
}
