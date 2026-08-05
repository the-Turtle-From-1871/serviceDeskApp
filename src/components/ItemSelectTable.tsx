"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { StatusBadge } from "@/components/StatusBadge";
import { AuditLight } from "@/components/AuditLight";
import { MarkReadyButton } from "@/components/MarkReadyButton";
import { ReadinessControls } from "@/components/ReadinessControls";
import { DeleteItemButton } from "@/components/DeleteItemButton";
import { toggleItemStatusAction } from "@/app/admin/actions/items";
import { MAX_RECEIPT_ROWS, MAX_ITEMS_PER_ROW } from "@/modules/transfers/receipt-lines";
import {
  READINESS_LABEL,
  ITEM_COLUMNS,
  SORTABLE_COLUMNS,
  parseHiddenCols,
  selectableIds,
  selectAllState,
  type ColumnKey,
  type ItemRow,
} from "@/components/items-view";
import { makeStore, usePersistedPref } from "@/components/persisted-pref";
import type { SortKey } from "@/modules/items/items.service";

export type { ItemRow };

const HIDDEN_KEY = "items:hiddenCols";
// Category is hidden by default: the table already carries a lot of columns,
// and category is opt-in for people who work by device class. It stays
// filterable and sortable while hidden. (Only applies to new visitors — an
// existing stored preference wins over this default.)
const DEFAULT_HIDDEN: ColumnKey[] = ["deviceCategory"];
const hiddenStore = makeStore(HIDDEN_KEY, parseHiddenCols);

// Re-export rather than redeclare: the shape is owned by listItems, which is
// what parses and consumes it.
export type { SortKey };

export function ItemSelectTable({
  items,
  isAdmin,
  q,
  sort,
  dir,
  page,
  totalPages,
  sortKeys,
  uic,
  uics,
  categories = [],
}: {
  items: ItemRow[];
  isAdmin: boolean;
  q: string;
  sort: string | null;
  dir: "asc" | "desc";
  page: number;
  totalPages: number;
  sortKeys: SortKey[];
  uic: string | null;
  uics: string[];
  /** The managed DeviceCategory vocabulary, fetched ONCE server-side by the page
   *  and passed down — never a per-row lookup. Only used by the admin bulk
   *  controls in the selection bar. */
  categories?: { name: string }[];
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
  const isHidden = (key: ColumnKey) => hidden.includes(key);
  const visibleCols = ITEM_COLUMNS.filter((c) => !isHidden(c.key));

  const toggleCol = (key: ColumnKey) => {
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

  const renderRow = (it: ItemRow) => (
    <tr key={it.id}>
      <td data-label="Select">{it.status === "ACTIVE" && <input type="checkbox" checked={selected.has(it.id)} onChange={() => toggle(it)} aria-label={`Select ${it.deviceName ?? ""} ${it.make} ${it.model} ${it.serialNumber}`} />}</td>
      {!isHidden("deviceName") && <td data-label="Device Name">{it.deviceName ? it.deviceName : <span className="subtle">—</span>}</td>}
      {!isHidden("make") && <td data-label="Make">{it.make}</td>}
      {!isHidden("model") && <td data-label="Model">{it.model}</td>}
      {!isHidden("serialNumber") && <td className="mono" data-label="Serial">{it.serialNumber}</td>}
      {!isHidden("holder") && <td data-label="Holder">{it.holderName ?? <span className="subtle">—</span>}</td>}
      {!isHidden("deviceUIC") && <td className="mono" data-label="UIC">{it.deviceUIC ?? <span className="subtle">—</span>}</td>}
      {!isHidden("deviceCategory") && <td data-label="Category">{it.deviceCategory ?? <span className="subtle">—</span>}</td>}
      {/* Derived server-side (readiness.query.ts), so no client-side narrowing
          of an untrusted stored value is needed — the row already carries a
          real ReadinessState. Accountability used to ride along here as a "Not
          accounted for" badge off Item.isAccountedFor; that flag is gone —
          the Audit column IS the accountability signal now. */}
      {!isHidden("readiness") && <td data-label="Readiness">{READINESS_LABEL[it.readiness]}</td>}
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
          {isAdmin && (
            <DeleteItemButton id={it.id} make={it.make} model={it.model} serialNumber={it.serialNumber} />
          )}
        </div>
      </td>
    </tr>
  );

  const selectedKeys = () => [...selected.keys()].join(",");
  const create = () => { if (selected.size && !tooMany && !tooManyPerRow) router.push(`/receipts/new?items=${selectedKeys()}`); };
  const printQr = () => { if (selected.size) window.open(`/admin/items/qr-sheet/pdf?items=${selectedKeys()}&preview=1`, "_blank", "noopener"); };

  // Build a /items URL preserving the current query, overriding only what changes.
  // Changing the sort/filter resets to page 1; paging keeps them.
  //
  // Compound sort travels as parallel comma lists (`sort=make,serialNumber` +
  // `dir=asc,asc`) — the server pairs them positionally, so the two lists must
  // always be written together and in the same order.
  const hrefFor = (over: {
    keys?: SortKey[];
    page?: number;
    uic?: string | null;
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
        <div className="card empty stack">
          <div>No items match {uic ? "this unit and " : ""}your search.</div>
          {/* Admin-only because creation is admin-only (createItemAction calls
              requireAdmin) — the server check is the authority, this is
              presentation. Deliberately NOT suppressed while a uic filter is
              active: q + uic can return nothing for an item that exists under a
              DIFFERENT uic, so this can be clicked for a serial already in the
              book. That is accepted — the action's P2002 branch names the
              collision and links to the item — because an admin filtered to a
              unit may legitimately be adding a device. */}
          {isAdmin && q.trim() && (
            <Link
              href={`/admin/items/new?serialNumber=${encodeURIComponent(q.trim())}${uic ? `&uic=${encodeURIComponent(uic)}` : ""}`}
              className="btn btn-secondary btn-sm"
            >
              <span className="truncate-inline">
                + Create &ldquo;{q.trim()}&rdquo; as a new item
              </span>
            </Link>
          )}
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
            {items.map(renderRow)}
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
        // zIndex keeps this bar above the table rows it floats over.
        <div className="card stack-sm" style={{ position: "sticky", bottom: 0, zIndex: 2 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span>{selected.size} selected · {groupCount} row{groupCount === 1 ? "" : "s"}</span>
            {tooMany
              ? <span role="alert" className="alert-error">Too many item types ({groupCount}). Max {MAX_RECEIPT_ROWS} per receipt — split into two.</span>
              : tooManyPerRow
              ? <span role="alert" className="alert-error">Too many of one item ({maxGroupSize}). Max {MAX_ITEMS_PER_ROW} per row — split into two.</span>
              : <button className="btn btn-primary" onClick={create}>Create receipt from {selected.size} selected</button>}
          </div>
          {/* The bulk "Set accountability" select is gone for good —
              accountability comes from audit evidence (record an audit
              instead), never from a checkbox.

              "Set readiness" is back, but it does NOT store a readiness value:
              it writes the underlying signals readiness.ts derives from
              (markedReadyAt, Item.status), and refuses the two states that are
              observed rather than asserted. See ReadinessControls. The
              one-click "Mark as on hand" stays as the fast path and routes
              through the same markItemsReady service function. */}
          {/* One wrapping row, NOT the card's default vertical stack: this bar is
              sticky and overlays the table, so every line of height hides another
              row of what you are selecting from. Stacked, it covered a phone
              viewport entirely. `flex-end` bottom-aligns the one-click button
              with the Apply buttons, whose selects carry a label above them. */}
          {isAdmin && (
            <div className="row" style={{ gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
              <MarkReadyButton
                itemIds={[...selected.keys()]}
                onDone={() => setSelected(new Map())}
              />
              {/* No onDone: unlike "Mark as on hand", these controls keep the
                  selection so their outcome message survives (clearing it
                  unmounts this whole bar), and so readiness and category can be
                  applied in one pass. */}
              <ReadinessControls
                itemIds={[...selected.keys()]}
                categories={categories}
              />
            </div>
          )}
        </div>
      )}
    </>
  );
}
