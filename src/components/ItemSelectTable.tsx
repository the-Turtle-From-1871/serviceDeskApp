"use client";
import { Fragment, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { StatusBadge } from "@/components/StatusBadge";
import { AuditLight } from "@/components/AuditLight";
import { toggleItemStatusAction, bulkUpdateReadinessAction } from "@/app/admin/actions/items";
import { MAX_RECEIPT_ROWS, MAX_ITEMS_PER_ROW } from "@/modules/transfers/receipt-lines";
import {
  DEPLOYABLE_LABEL,
  DEPLOYABLE_ORDER,
  deployableKey,
  groupByReadiness,
  ITEM_COLUMNS,
  parseHiddenCols,
  selectableIds,
  selectAllState,
  type ItemRow,
  type SortField,
} from "@/components/items-view";
import { makeStore, usePersistedPref } from "@/components/persisted-pref";
import type { SortKey } from "@/modules/items/items.service";

export type { ItemRow };

const HIDDEN_KEY = "items:hiddenCols";
// Category is hidden by default: the table already carries a lot of columns,
// and category is opt-in for people who work by device class. It stays
// filterable and sortable while hidden. (Only applies to new visitors — an
// existing stored preference wins over this default.)
const DEFAULT_HIDDEN: SortField[] = ["deviceCategory"];
const hiddenStore = makeStore(HIDDEN_KEY, parseHiddenCols);

// Re-export rather than redeclare: the shape is owned by listItems, which is
// what parses and consumes it.
export type { SortKey };

// Every column is server-sortable. `auditState` (the derived badge) sorts via the
// denormalized Item.lastAuditedAt column server-side (see listItems), so it's
// offered in the Sort control like the rest.
const SORTABLE_COLUMNS = ITEM_COLUMNS;

export function ItemSelectTable({
  items,
  isAdmin,
  q,
  sort,
  dir,
  page,
  totalPages,
  sortKeys,
  grouped,
  uic,
  uics,
}: {
  items: ItemRow[];
  isAdmin: boolean;
  q: string;
  sort: string | null;
  dir: "asc" | "desc";
  page: number;
  totalPages: number;
  sortKeys: SortKey[];
  grouped: boolean;
  uic: string | null;
  uics: string[];
}) {
  const router = useRouter();
  const secondarySort = sortKeys[1] ?? null;

  // Selection is a Map (id -> row), not a Set of ids, so it survives paging: the
  // receipt-group validation below needs each selected item's make/model, and an
  // item selected on page 1 is no longer in `items` once you page forward. You can
  // only ever select a row you can see, so its details are captured at select time.
  const [selected, setSelected] = useState<Map<string, ItemRow>>(new Map());
  const selectedIds = useMemo(() => new Set(selected.keys()), [selected]);
  const toggle = (row: ItemRow) =>
    setSelected((prev) => {
      const n = new Map(prev);
      if (n.has(row.id)) n.delete(row.id);
      else n.set(row.id, row);
      return n;
    });

  const allState = useMemo(() => selectAllState(items, selectedIds), [items, selectedIds]);
  const selectableCount = useMemo(() => selectableIds(items).length, [items]);
  // "Select all" acts on the CURRENT page's selectable rows, leaving off-page
  // selections untouched.
  const toggleAll = () =>
    setSelected((prev) => {
      const n = new Map(prev);
      const pageActive = items.filter((it) => it.status === "ACTIVE");
      const allOnPage = pageActive.length > 0 && pageActive.every((it) => n.has(it.id));
      if (allOnPage) for (const it of pageActive) n.delete(it.id);
      else for (const it of pageActive) n.set(it.id, it);
      return n;
    });

  // View preferences (column visibility) persist to localStorage. Sort + paging are
  // URL-driven (server-side), so they are NOT stored here.
  const [hidden, setHidden] = usePersistedPref(hiddenStore, DEFAULT_HIDDEN);
  const isHidden = (key: SortField) => hidden.includes(key);
  const visibleCols = ITEM_COLUMNS.filter((c) => !isHidden(c.key));

  const toggleCol = (key: SortField) => {
    const next = new Set(hidden);
    if (next.has(key)) { next.delete(key); setHidden([...next]); return; }
    // Keep at least one data column visible.
    if (ITEM_COLUMNS.length - next.size <= 1) return;
    next.add(key);
    setHidden([...next]);
  };

  // Group validation runs over ALL selected items (every page), from the Map values.
  const groupCount = useMemo(
    () => new Set([...selected.values()].map((it) => `${it.make} ${it.model}`)).size,
    [selected],
  );
  const tooMany = groupCount > MAX_RECEIPT_ROWS;
  const maxGroupSize = useMemo(() => {
    const counts = new Map<string, number>();
    for (const it of selected.values()) {
      const key = `${it.make} ${it.model}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    let max = 0;
    for (const n of counts.values()) if (n > max) max = n;
    return max;
  }, [selected]);
  const tooManyPerRow = maxGroupSize > MAX_ITEMS_PER_ROW;

  // 1 select column + the visible data columns + 1 actions column.
  const colCount = visibleCols.length + 2;

  const renderRow = (it: ItemRow) => (
    <tr key={it.id}>
      <td data-label="Select">{it.status === "ACTIVE" && <input type="checkbox" checked={selected.has(it.id)} onChange={() => toggle(it)} aria-label={`Select ${it.deviceName ?? ""} ${it.make} ${it.model} ${it.serialNumber}`} />}</td>
      {!isHidden("deviceName") && <td data-label="Device Name">{it.deviceName ? it.deviceName : <span className="subtle">—</span>}</td>}
      {!isHidden("make") && <td data-label="Make">{it.make}</td>}
      {!isHidden("model") && <td data-label="Model">{it.model}</td>}
      {!isHidden("serialNumber") && <td className="mono" data-label="Serial">{it.serialNumber}</td>}
      {!isHidden("deviceUIC") && <td className="mono" data-label="UIC">{it.deviceUIC ?? <span className="subtle">—</span>}</td>}
      {!isHidden("deviceCategory") && <td data-label="Category">{it.deviceCategory ?? <span className="subtle">—</span>}</td>}
      {!isHidden("deployableStatus") && (
        <td data-label="Readiness">
          {DEPLOYABLE_LABEL[deployableKey(it.deployableStatus)]}
          {/* Accountability is a flag, not a status, so it rides alongside the
              readiness cell rather than claiming a column of its own. */}
          {!it.isAccountedFor && <span className="badge badge-danger" style={{ marginLeft: 6 }}>Not accounted for</span>}
          {/* `badge-danger` is defined in globals.css alongside badge-override. */}
        </td>
      )}
      {!isHidden("status") && <td data-label="Status"><StatusBadge status={it.status} /></td>}
      {!isHidden("auditState") && <td data-label="Audit" style={{ textAlign: "center" }}><AuditLight state={it.auditState} /></td>}
      <td data-label="">
        <div className="actions actions--end">
          <Link href={`/i/${it.id}`} className="btn btn-ghost btn-sm">View</Link>
          {isAdmin && <Link href={`/admin/items/${it.id}/edit`} className="btn btn-ghost btn-sm">Edit</Link>}
          {isAdmin && (
            <form action={toggleItemStatusAction}>
              <input type="hidden" name="id" value={it.id} />
              <input type="hidden" name="status" value={it.status === "RETIRED" ? "ACTIVE" : "RETIRED"} />
              <button type="submit" className={`btn btn-sm ${it.status === "RETIRED" ? "btn-secondary" : "btn-danger"}`}>{it.status === "RETIRED" ? "Reactivate" : "Retire"}</button>
            </form>
          )}
        </div>
      </td>
    </tr>
  );

  const selectedKeys = () => [...selected.keys()].join(",");
  const create = () => { if (selected.size && !tooMany && !tooManyPerRow) router.push(`/receipts/new?items=${selectedKeys()}`); };
  const printQr = () => { if (selected.size) window.open(`/admin/items/qr-sheet/pdf?items=${selectedKeys()}&preview=1`, "_blank", "noopener"); };

  // Build a /items URL preserving the current query, overriding only what changes.
  // Changing the sort/filter/grouping resets to page 1; paging keeps them.
  //
  // Compound sort travels as parallel comma lists (`sort=make,serialNumber` +
  // `dir=asc,asc`) — the server pairs them positionally, so the two lists must
  // always be written together and in the same order.
  const hrefFor = (over: {
    keys?: SortKey[];
    page?: number;
    uic?: string | null;
    grouped?: boolean;
  }) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);

    const nextKeys = over.keys ?? sortKeys;
    if (nextKeys.length > 0) {
      params.set("sort", nextKeys.map((k) => k.key).join(","));
      params.set("dir", nextKeys.map((k) => k.dir).join(","));
    }

    const nextUic = over.uic !== undefined ? over.uic : uic;
    if (nextUic) params.set("uic", nextUic);

    const nextGrouped = over.grouped !== undefined ? over.grouped : grouped;
    // Grouping is the default, so only the OFF state needs to be in the URL.
    if (!nextGrouped) params.set("group", "none");

    const nextPage = over.page ?? page;
    if (nextPage > 1) params.set("page", String(nextPage));

    const s = params.toString();
    return s ? `/items?${s}` : "/items";
  };
  const navigate = (over: Parameters<typeof hrefFor>[0]) => router.push(hrefFor(over));

  /** Replace the primary sort, keeping any secondary key that isn't now a duplicate. */
  const setPrimary = (key: string | null) => {
    if (!key) return navigate({ keys: [], page: 1 });
    const kept = sortKeys.slice(1).filter((k) => k.key !== key);
    navigate({ keys: [{ key, dir }, ...kept], page: 1 });
  };
  const setSecondary = (key: string | null) => {
    if (sortKeys.length === 0) return;
    const primary = sortKeys[0];
    navigate({ keys: key ? [primary, { key, dir: "asc" }] : [primary], page: 1 });
  };
  const flipPrimaryDir = () => {
    if (sortKeys.length === 0) return;
    const [first, ...rest] = sortKeys;
    navigate({ keys: [{ ...first, dir: first.dir === "asc" ? "desc" : "asc" }, ...rest], page: 1 });
  };

  return (
    <>
      <div className="toolbar" style={{ gap: 8, alignItems: "flex-end" }}>
        <label className="stack" style={{ gap: 4 }}>
          <span className="subtle" style={{ fontSize: 12 }}>Sort by</span>
          <select
            className="select toolbar__control"
            value={sort ?? ""}
            onChange={(e) => setPrimary(e.target.value || null)}
          >
            <option value="">Default (newest)</option>
            {SORTABLE_COLUMNS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
        </label>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={!sort}
          onClick={flipPrimaryDir}
          aria-label={dir === "asc" ? "Ascending" : "Descending"}
        >
          {dir === "asc" ? "Asc ▲" : "Desc ▼"}
        </button>
        {/* Compound sort: "Manufacturer, then Serial Number". Only offered once
            a primary key is chosen — a tie-breaker with nothing to break is
            meaningless, and the default (newest) sort has no ties worth
            resolving. The primary column is excluded from the options. */}
        <label className="stack" style={{ gap: 4 }}>
          <span className="subtle" style={{ fontSize: 12 }}>Then by</span>
          <select
            className="select toolbar__control"
            value={secondarySort?.key ?? ""}
            disabled={!sort}
            onChange={(e) => setSecondary(e.target.value || null)}
          >
            <option value="">—</option>
            {SORTABLE_COLUMNS.filter((c) => c.key !== sort).map((c) => (
              <option key={c.key} value={c.key}>{c.label}</option>
            ))}
          </select>
        </label>
        <label className="stack" style={{ gap: 4 }}>
          <span className="subtle" style={{ fontSize: 12 }}>Unit (UIC)</span>
          <select
            className="select toolbar__control"
            value={uic ?? ""}
            onChange={(e) => navigate({ uic: e.target.value || null, page: 1 })}
          >
            <option value="">All units</option>
            {uics.map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
        </label>
        <label className="row" style={{ gap: 6, alignItems: "center" }}>
          <input
            type="checkbox"
            checked={grouped}
            onChange={(e) => navigate({ grouped: e.target.checked, page: 1 })}
          />
          <span className="subtle" style={{ fontSize: 12 }}>
            Group by readiness
            {/* Grouping is an ORDER BY that runs ahead of the chosen sort, so
                say so — otherwise "sorted by Serial" quietly means "sorted by
                serial *within each readiness group*". */}
            {grouped && sort && sort !== "deployableStatus" && (
              <span className="subtle"> (sort applies within each group)</span>
            )}
          </span>
        </label>
        {isAdmin && (
          <button
            type="button"
            className="btn btn-primary"
            disabled={selected.size === 0}
            onClick={printQr}
            title={selected.size === 0 ? "Select items to print QR labels" : undefined}
          >
            Print QR codes{selected.size ? ` (${selected.size})` : ""}
          </button>
        )}
        <details className="col-menu spacer">
          <summary className="btn btn-secondary">Columns</summary>
          <div className="col-menu-panel">
            {ITEM_COLUMNS.map((c) => {
              const shown = !isHidden(c.key);
              const lastVisible = shown && visibleCols.length <= 1;
              return (
                <label key={c.key} title={lastVisible ? "At least one column must stay visible" : undefined}>
                  <input type="checkbox" checked={shown} disabled={lastVisible} onChange={() => toggleCol(c.key)} />
                  {c.label}
                </label>
              );
            })}
          </div>
        </details>
      </div>

      {/* Rendered below the toolbar, so the controls that produced an empty
          result stay on screen and the filter can be undone. */}
      {items.length === 0 && (
        <div className="card empty">
          No items match {uic ? "this unit and " : ""}your search.
        </div>
      )}

      <div className="table-wrap" hidden={items.length === 0}>
        <table className="table">
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  checked={allState === "all"}
                  disabled={selectableCount === 0}
                  // React has no `indeterminate` prop — it is a DOM-only property.
                  ref={(el) => { if (el) el.indeterminate = allState === "some"; }}
                  onChange={toggleAll}
                  aria-label={allState === "all" ? "Deselect all items on this page" : "Select all items on this page"}
                  title={selectableCount === 0 ? "No selectable items" : undefined}
                />
              </th>
              {visibleCols.map((c) => (
                <th key={c.key} style={c.key === "auditState" ? { textAlign: "center" } : undefined}>{c.label}{sort === c.key ? (dir === "asc" ? " ▲" : " ▼") : ""}</th>
              ))}
              <th style={{ textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {grouped
              ? groupByReadiness(items).map((g) => (
                  <Fragment key={g.key}>
                    {/* A group header repeats if a group spans a page break —
                        the page is a window onto a server-ordered list, so the
                        header states which group the rows below belong to
                        rather than implying the group starts here. */}
                    <tr className="group-row">
                      <th colSpan={colCount} scope="colgroup">
                        {DEPLOYABLE_LABEL[g.key]}{" "}
                        <span className="subtle">({g.rows.length} on this page)</span>
                      </th>
                    </tr>
                    {g.rows.map(renderRow)}
                  </Fragment>
                ))
              : items.map(renderRow)}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="row" style={{ justifyContent: "center", gap: 12, alignItems: "center" }}>
          <button type="button" className="btn btn-secondary btn-sm" disabled={page <= 1} onClick={() => navigate({ page: page - 1 })}>← Prev</button>
          <span className="subtle">Page {page} of {totalPages}</span>
          <button type="button" className="btn btn-secondary btn-sm" disabled={page >= totalPages} onClick={() => navigate({ page: page + 1 })}>Next →</button>
        </div>
      )}

      {selected.size > 0 && (
        // zIndex must beat the sticky group headers (.group-row th, z-index 1),
        // or a header scrolling past renders on top of these controls.
        <div className="card stack-sm" style={{ position: "sticky", bottom: 0, zIndex: 2 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span>{selected.size} selected · {groupCount} row{groupCount === 1 ? "" : "s"}</span>
            {tooMany
              ? <span role="alert" className="alert-error">Too many item types ({groupCount}). Max {MAX_RECEIPT_ROWS} per receipt — split into two.</span>
              : tooManyPerRow
              ? <span role="alert" className="alert-error">Too many of one item ({maxGroupSize}). Max {MAX_ITEMS_PER_ROW} per row — split into two.</span>
              : <button className="btn btn-primary" onClick={create}>Create receipt from {selected.size} selected</button>}
          </div>
          {isAdmin && (
            <BulkReadinessBar
              itemIds={[...selected.keys()]}
              onDone={() => setSelected(new Map())}
            />
          )}
        </div>
      )}
    </>
  );
}

/**
 * Admin-only bulk edit of readiness fields for the current selection.
 *
 * Rendered only for admins, but that is presentation — the server action
 * re-checks with requireAdmin(), which is the actual boundary.
 */
function BulkReadinessBar({ itemIds, onDone }: { itemIds: string[]; onDone: () => void }) {
  const router = useRouter();
  const [status, setStatus] = useState("");
  const [accounted, setAccounted] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const nothingChosen = !status && !accounted;

  const apply = () => {
    setMessage(null);
    const fd = new FormData();
    fd.set("itemIds", itemIds.join(","));
    if (status) fd.set("deployableStatus", status);
    if (accounted) fd.set("isAccountedFor", accounted);

    startTransition(async () => {
      const res = await bulkUpdateReadinessAction(fd);
      if ("error" in res && res.error) {
        setMessage({ ok: false, text: res.error });
        return;
      }
      const n = "updated" in res ? res.updated : 0;
      setMessage({
        ok: true,
        // "0 changed" is a real, useful outcome (every selected item already
        // had that state) — report it rather than implying work happened.
        text: n === 0 ? "No changes — those items already had that state." : `Updated ${n} item${n === 1 ? "" : "s"}.`,
      });
      setStatus("");
      setAccounted("");
      onDone();
      router.refresh();
    });
  };

  return (
    <div className="row" style={{ gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
      <label className="stack" style={{ gap: 4 }}>
        <span className="subtle" style={{ fontSize: 12 }}>Set readiness</span>
        <select className="select" value={status} onChange={(e) => setStatus(e.target.value)} disabled={pending}>
          <option value="">Leave unchanged</option>
          {DEPLOYABLE_ORDER.map((k) => (
            <option key={k} value={k}>{DEPLOYABLE_LABEL[k]}</option>
          ))}
        </select>
      </label>
      <label className="stack" style={{ gap: 4 }}>
        <span className="subtle" style={{ fontSize: 12 }}>Set accountability</span>
        <select className="select" value={accounted} onChange={(e) => setAccounted(e.target.value)} disabled={pending}>
          <option value="">Leave unchanged</option>
          <option value="true">Accounted for</option>
          <option value="false">Not accounted for</option>
        </select>
      </label>
      <button
        type="button"
        className="btn btn-secondary"
        disabled={pending || nothingChosen}
        onClick={apply}
        title={nothingChosen ? "Choose a change to apply" : undefined}
      >
        {pending ? "Applying…" : `Apply to ${itemIds.length}`}
      </button>
      {message && (
        <span role="status" className={message.ok ? "subtle" : "alert-error"}>{message.text}</span>
      )}
    </div>
  );
}
