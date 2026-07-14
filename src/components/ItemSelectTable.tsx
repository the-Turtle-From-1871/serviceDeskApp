"use client";
import { useMemo, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { StatusBadge } from "@/components/StatusBadge";
import { toggleItemStatusAction } from "@/app/admin/actions/items";
import { MAX_RECEIPT_ROWS, MAX_ITEMS_PER_ROW } from "@/modules/transfers/receipt-lines";
import {
  ITEM_COLUMNS,
  sortItemRows,
  parseSortPref,
  parseHiddenCols,
  selectableIds,
  selectAllState,
  type ItemRow,
  type SortField,
  type SortPref,
} from "@/components/items-view";

export type { ItemRow };

const SORT_KEY = "items:sort";
const HIDDEN_KEY = "items:hiddenCols";
const DEFAULT_SORT: SortPref = { field: null, dir: "asc" };
const DEFAULT_HIDDEN: SortField[] = [];

/** A tiny localStorage-backed store, created at module scope so its mutable
 *  cache lives outside React's render cycle. Read via useSyncExternalStore so
 *  the server snapshot (default) is used during SSR/hydration and the persisted
 *  value takes over on the client — no hydration mismatch, no setState-in-effect.
 *  Also syncs across tabs via the `storage` event. */
function makeStore<T>(key: string, parse: (raw: string | null) => T) {
  const listeners = new Set<() => void>();
  let cacheRaw: string | null | undefined;
  let cacheVal: T;
  return {
    get(): T {
      let raw: string | null = null;
      try { raw = window.localStorage.getItem(key); } catch { /* unavailable */ }
      if (cacheRaw !== raw) { cacheRaw = raw; cacheVal = parse(raw); }
      return cacheVal;
    },
    set(value: T) {
      try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* unavailable */ }
      cacheRaw = undefined;
      listeners.forEach((l) => l());
    },
    subscribe(cb: () => void) {
      listeners.add(cb);
      const onStorage = (e: StorageEvent) => { if (e.key === key) { cacheRaw = undefined; cb(); } };
      window.addEventListener("storage", onStorage);
      return () => { listeners.delete(cb); window.removeEventListener("storage", onStorage); };
    },
  };
}

const sortStore = makeStore(SORT_KEY, parseSortPref);
const hiddenStore = makeStore(HIDDEN_KEY, parseHiddenCols);

function usePersistedPref<T>(store: { get: () => T; set: (v: T) => void; subscribe: (cb: () => void) => () => void }, serverDefault: T): [T, (value: T) => void] {
  const value = useSyncExternalStore(store.subscribe, store.get, () => serverDefault);
  return [value, store.set];
}

export function ItemSelectTable({ items, isAdmin }: { items: ItemRow[]; isAdmin: boolean }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const allState = useMemo(() => selectAllState(items, selected), [items, selected]);
  const selectableCount = useMemo(() => selectableIds(items).length, [items]);
  const toggleAll = () => setSelected(allState === "all" ? new Set() : new Set(selectableIds(items)));

  // View preferences persisted to localStorage (survive reloads + navigation).
  const [sort, setSort] = usePersistedPref(sortStore, DEFAULT_SORT);
  const [hidden, setHidden] = usePersistedPref(hiddenStore, DEFAULT_HIDDEN);

  const sorted = useMemo(() => sortItemRows(items, sort.field, sort.dir), [items, sort]);
  const isHidden = (key: SortField) => hidden.includes(key);

  const toggleCol = (key: SortField) => {
    const next = new Set(hidden);
    if (next.has(key)) { next.delete(key); setHidden([...next]); return; }
    // Keep at least one data column visible.
    if (ITEM_COLUMNS.length - next.size <= 1) return;
    next.add(key);
    setHidden([...next]);
  };

  const groupCount = useMemo(() => {
    const keys = new Set<string>();
    for (const it of items) if (selected.has(it.id)) keys.add(`${it.make} ${it.model}`);
    return keys.size;
  }, [selected, items]);
  const tooMany = groupCount > MAX_RECEIPT_ROWS;

  const maxGroupSize = useMemo(() => {
    const counts = new Map<string, number>();
    for (const it of items) if (selected.has(it.id)) counts.set(`${it.make} ${it.model}`, (counts.get(`${it.make} ${it.model}`) ?? 0) + 1);
    let max = 0;
    for (const n of counts.values()) if (n > max) max = n;
    return max;
  }, [selected, items]);
  const tooManyPerRow = maxGroupSize > MAX_ITEMS_PER_ROW;

  const create = () => { if (selected.size && !tooMany && !tooManyPerRow) router.push(`/receipts/new?items=${[...selected].join(",")}`); };

  const printQr = () => { if (selected.size) window.open(`/admin/items/qr-sheet/pdf?items=${[...selected].join(",")}&preview=1`, "_blank", "noopener"); };

  const visibleCols = ITEM_COLUMNS.filter((c) => !isHidden(c.key));

  return (
    <>
      <div className="row" style={{ gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
        <label className="stack" style={{ gap: 4 }}>
          <span className="subtle" style={{ fontSize: 12 }}>Sort by</span>
          <select
            className="select"
            style={{ width: "auto", minWidth: 150 }}
            value={sort.field ?? ""}
            onChange={(e) => setSort({ ...sort, field: (e.target.value || null) as SortField | null })}
          >
            <option value="">Default (newest)</option>
            {ITEM_COLUMNS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
        </label>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={!sort.field}
          onClick={() => setSort({ ...sort, dir: sort.dir === "asc" ? "desc" : "asc" })}
          aria-label={sort.dir === "asc" ? "Ascending" : "Descending"}
        >
          {sort.dir === "asc" ? "Asc ▲" : "Desc ▼"}
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
                  aria-label={allState === "all" ? "Deselect all items" : "Select all items"}
                  title={selectableCount === 0 ? "No selectable items" : undefined}
                />
              </th>
              {visibleCols.map((c) => (
                <th key={c.key}>{c.label}{sort.field === c.key ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}</th>
              ))}
              <th style={{ textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((it) => (
              <tr key={it.id}>
                <td>{it.status === "ACTIVE" && <input type="checkbox" checked={selected.has(it.id)} onChange={() => toggle(it.id)} aria-label={`Select ${it.deviceName ?? ""} ${it.make} ${it.model} ${it.serialNumber}`} />}</td>
                {!isHidden("deviceName") && <td data-label="Device Name">{it.deviceName ? it.deviceName : <span className="subtle">—</span>}</td>}
                {!isHidden("make") && <td data-label="Make">{it.make}</td>}
                {!isHidden("model") && <td data-label="Model">{it.model}</td>}
                {!isHidden("serialNumber") && <td className="mono" data-label="Serial">{it.serialNumber}</td>}
                {!isHidden("status") && <td data-label="Status"><StatusBadge status={it.status} /></td>}
                <td data-label="">
                  <div className="actions" style={{ justifyContent: "flex-end" }}>
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
