"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { StatusBadge } from "@/components/StatusBadge";
import { AuditLight } from "@/components/AuditLight";
import { toggleItemStatusAction } from "@/app/admin/actions/items";
import { MAX_RECEIPT_ROWS, MAX_ITEMS_PER_ROW } from "@/modules/transfers/receipt-lines";
import {
  ITEM_COLUMNS,
  parseHiddenCols,
  selectableIds,
  selectAllState,
  type ItemRow,
  type SortField,
} from "@/components/items-view";
import { makeStore, usePersistedPref } from "@/components/persisted-pref";

export type { ItemRow };

const HIDDEN_KEY = "items:hiddenCols";
const DEFAULT_HIDDEN: SortField[] = [];
const hiddenStore = makeStore(HIDDEN_KEY, parseHiddenCols);

// auditState is a derived (non-column) value, so it can't be an ORDER BY — offer
// only the server-sortable columns in the Sort control.
const SORTABLE_COLUMNS = ITEM_COLUMNS.filter((c) => c.key !== "auditState");

export function ItemSelectTable({
  items,
  isAdmin,
  q,
  sort,
  dir,
  page,
  totalPages,
}: {
  items: ItemRow[];
  isAdmin: boolean;
  q: string;
  sort: string | null;
  dir: "asc" | "desc";
  page: number;
  totalPages: number;
}) {
  const router = useRouter();

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

  const selectedKeys = () => [...selected.keys()].join(",");
  const create = () => { if (selected.size && !tooMany && !tooManyPerRow) router.push(`/receipts/new?items=${selectedKeys()}`); };
  const printQr = () => { if (selected.size) window.open(`/admin/items/qr-sheet/pdf?items=${selectedKeys()}&preview=1`, "_blank", "noopener"); };

  // Build a /items URL preserving the current query, overriding only what changes.
  // Changing the sort resets to page 1; paging keeps the sort.
  const hrefFor = (over: { sort?: string | null; dir?: "asc" | "desc"; page?: number }) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    const nextSort = over.sort !== undefined ? over.sort : sort;
    const nextDir = over.dir ?? dir;
    const nextPage = over.page ?? page;
    if (nextSort) { params.set("sort", nextSort); params.set("dir", nextDir); }
    if (nextPage > 1) params.set("page", String(nextPage));
    const s = params.toString();
    return s ? `/items?${s}` : "/items";
  };
  const navigate = (over: { sort?: string | null; dir?: "asc" | "desc"; page?: number }) => router.push(hrefFor(over));

  return (
    <>
      <div className="toolbar" style={{ gap: 8, alignItems: "flex-end" }}>
        <label className="stack" style={{ gap: 4 }}>
          <span className="subtle" style={{ fontSize: 12 }}>Sort by</span>
          <select
            className="select toolbar__control"
            value={sort ?? ""}
            onChange={(e) => navigate({ sort: e.target.value || null, page: 1 })}
          >
            <option value="">Default (newest)</option>
            {SORTABLE_COLUMNS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
        </label>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={!sort}
          onClick={() => navigate({ dir: dir === "asc" ? "desc" : "asc", page: 1 })}
          aria-label={dir === "asc" ? "Ascending" : "Descending"}
        >
          {dir === "asc" ? "Asc ▲" : "Desc ▼"}
        </button>
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

      <div className="table-wrap">
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
                <th key={c.key}>{c.label}{sort === c.key ? (dir === "asc" ? " ▲" : " ▼") : ""}</th>
              ))}
              <th style={{ textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.id}>
                <td data-label="Select">{it.status === "ACTIVE" && <input type="checkbox" checked={selected.has(it.id)} onChange={() => toggle(it)} aria-label={`Select ${it.deviceName ?? ""} ${it.make} ${it.model} ${it.serialNumber}`} />}</td>
                {!isHidden("deviceName") && <td data-label="Device Name">{it.deviceName ? it.deviceName : <span className="subtle">—</span>}</td>}
                {!isHidden("make") && <td data-label="Make">{it.make}</td>}
                {!isHidden("model") && <td data-label="Model">{it.model}</td>}
                {!isHidden("serialNumber") && <td className="mono" data-label="Serial">{it.serialNumber}</td>}
                {!isHidden("status") && <td data-label="Status"><StatusBadge status={it.status} /></td>}
                {!isHidden("auditState") && <td data-label="Audit"><AuditLight state={it.auditState} /></td>}
                <td data-label="">
                  <div className="actions actions--end">
                    <Link href={`/i/${it.id}`} className="btn btn-ghost btn-sm">View</Link>
                    {isAdmin && <Link href={`/admin/items/${it.id}/qr`} className="btn btn-ghost btn-sm">QR</Link>}
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
            ))}
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
        <div className="card row" style={{ position: "sticky", bottom: 0, justifyContent: "space-between" }}>
          <span>{selected.size} selected · {groupCount} row{groupCount === 1 ? "" : "s"}</span>
          {tooMany
            ? <span role="alert" className="alert-error">Too many item types ({groupCount}). Max {MAX_RECEIPT_ROWS} per receipt — split into two.</span>
            : tooManyPerRow
            ? <span role="alert" className="alert-error">Too many of one item ({maxGroupSize}). Max {MAX_ITEMS_PER_ROW} per row — split into two.</span>
            : <button className="btn btn-primary" onClick={create}>Create receipt from {selected.size} selected</button>}
        </div>
      )}
    </>
  );
}
