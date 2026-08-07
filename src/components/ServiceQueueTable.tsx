"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { completeServiceAction } from "@/app/admin/actions/queue";
import { makeStore, usePersistedPref } from "@/components/persisted-pref";
import { DueBadge } from "@/components/DueBadge";
import { useRowGestures } from "@/components/useRowGestures";
import {
  QUEUE_COLUMNS,
  sortQueueRows,
  filterQueueRows,
  parseQueueSort,
  parseQueueHidden,
  type QueueRowVM,
  type QueueSortField,
  type QueueSortPref,
  type QueueTypeFilter,
} from "@/components/service-queue-view";

const SORT_KEY = "queue:sort";
const HIDDEN_KEY = "queue:hiddenCols";
const DEFAULT_SORT: QueueSortPref = { field: null, dir: "asc" };
const DEFAULT_HIDDEN: QueueSortField[] = [];

const sortStore = makeStore(SORT_KEY, parseQueueSort);
const hiddenStore = makeStore(HIDDEN_KEY, parseQueueHidden);

const TYPE_FILTERS: { value: QueueTypeFilter; label: string }[] = [
  { value: "ALL", label: "All types" },
  { value: "REIMAGE", label: "Reimage" },
  { value: "REPAIR", label: "Repair" },
  { value: "OTHER", label: "Other" },
];

export function ServiceQueueTable({ rows }: { rows: QueueRowVM[] }) {
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<QueueTypeFilter>("ALL");
  const [sort, setSort] = usePersistedPref(sortStore, DEFAULT_SORT);
  const [hidden, setHidden] = usePersistedPref(hiddenStore, DEFAULT_HIDDEN);

  const isHidden = (key: QueueSortField) => hidden.includes(key);
  const visibleCols = QUEUE_COLUMNS.filter((c) => !isHidden(c.key));

  const shown = useMemo(() => {
    const filtered = filterQueueRows(rows, { search, type: typeFilter });
    return sortQueueRows(filtered, sort.field, sort.dir);
  }, [rows, search, typeFilter, sort]);

  const gestures = useRowGestures({
    // The whole page is behind requireAdmin (see admin/queue/page.tsx) and
    // every row's drawer holds the same one action, so there is never an empty
    // drawer to pull open.
    swipeEnabled: true,
    // The queue has no bulk selection — nothing to long-press INTO. Leaving it
    // on would arm a 500ms timer on every touch for no reachable outcome.
    longPressEnabled: false,
    onLongPress: () => {},
  });

  const toggleCol = (key: QueueSortField) => {
    const next = new Set(hidden);
    if (next.has(key)) { next.delete(key); setHidden([...next]); return; }
    if (QUEUE_COLUMNS.length - next.size <= 1) return; // keep one visible
    next.add(key);
    setHidden([...next]);
  };

  return (
    <>
      <div className="toolbar" style={{ gap: 8, alignItems: "flex-end" }}>
        <input
          className="input toolbar__search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search SN, device name, or unit"
          aria-label="Search the service queue"
        />
        <label className="stack" style={{ gap: 4 }}>
          <span className="subtle" style={{ fontSize: 12 }}>Service type</span>
          <select className="select toolbar__control" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as QueueTypeFilter)}>
            {TYPE_FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </label>
        <label className="stack" style={{ gap: 4 }}>
          <span className="subtle" style={{ fontSize: 12 }}>Sort by</span>
          <select
            className="select toolbar__control"
            value={sort.field ?? ""}
            onChange={(e) => setSort({ ...sort, field: (e.target.value || null) as QueueSortField | null })}
          >
            <option value="">Default (newest)</option>
            {QUEUE_COLUMNS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
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
        <details className="col-menu spacer">
          <summary className="btn btn-secondary">Columns</summary>
          <div className="col-menu-panel">
            {QUEUE_COLUMNS.map((c) => {
              const isShown = !isHidden(c.key);
              const lastVisible = isShown && visibleCols.length <= 1;
              return (
                <label key={c.key} title={lastVisible ? "At least one column must stay visible" : undefined}>
                  <input type="checkbox" checked={isShown} disabled={lastVisible} onChange={() => toggleCol(c.key)} />
                  {c.label}
                </label>
              );
            })}
          </div>
        </details>
      </div>

      {shown.length === 0 ? (
        <div className="card empty">No items match the current search or filter.</div>
      ) : (
        <div className="table-wrap">
          {/* Same `table--cards` treatment as /items: below 720px each row is a
              card you tap to open and swipe left for its action. The whole
              mechanism lives in globals.css and useRowGestures, so this table
              opts in with a class and three extra cells rather than repeating
              any of it. No `is-selecting` here — the queue has no selection. */}
          <table className="table table--cards">
            <thead>
              <tr>
                {visibleCols.map((c) => (
                  <th key={c.key}>{c.label}{sort.field === c.key ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}</th>
                ))}
                <th style={{ textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr
                  key={r.id}
                  {...gestures.pointerHandlers(r.id)}
                  style={{ ["--swipe" as string]: `${gestures.offsetFor(r.id)}px` }}
                  onClickCapture={(e) => {
                    // Only ever intercepts the card's own stretched link, and
                    // only to cancel the click a swipe left behind. There is no
                    // selection mode here, so nothing else to decide.
                    const link = (e.target as HTMLElement).closest?.("a.card-link");
                    if (!link) return;
                    if (gestures.consumeSuppressedClick(r.id)) {
                      e.preventDefault();
                      e.stopPropagation();
                    }
                  }}
                >
                  {!isHidden("serialNumber") && <td className="mono cell-desktop" data-label="SN">{r.serialNumber}</td>}
                  {!isHidden("deviceName") && <td className="cell-desktop" data-label="Device Name">{r.deviceName ? r.deviceName : <span className="subtle">—</span>}</td>}
                  {!isHidden("homeUnit") && <td className="cell-desktop" data-label="Unit">{r.homeUnit ? r.homeUnit : <span className="subtle">—</span>}</td>}
                  {!isHidden("serviceType") && <td className="cell-desktop" data-label="Service Type">{r.serviceType}</td>}
                  {!isHidden("due") && <td className="cell-desktop" data-label="Due"><DueBadge dueAt={r.dueAt} /></td>}

                  {/* The card, in three cells of its own — same reasoning as
                      ItemSelectTable: every cell above is rendered conditionally
                      by the Columns menu, so building the card from them would
                      let a hidden SN column leave a card with no heading and,
                      since the heading carries the link, no way to open it. */}
                  <td className="mono cell-serial" data-label="SN">
                    <Link
                      href={`/i/${r.itemId}`}
                      className="card-link"
                      aria-label={`View ${r.deviceName ?? "device"}, serial ${r.serialNumber}`}
                    >
                      {r.serialNumber}
                    </Link>
                  </td>
                  <td className="cell-primary" data-label="">
                    <span className="cell-primary__name">{r.deviceName ? r.deviceName : <span className="subtle">Unnamed device</span>}</span>
                    <span className="cell-primary__sub">{r.homeUnit ? r.homeUnit : "No unit"}</span>
                  </td>
                  <td className="cell-meta" data-label="">
                    <span className="cell-meta__facts">
                      <span className="subtle">{r.serviceType}</span>
                      <DueBadge dueAt={r.dueAt} />
                    </span>
                    <span className="swipe-grip" aria-hidden="true">‹</span>
                  </td>

                  <td className="row-actions" data-label="">
                    <div className="actions actions--end">
                      <Link href={`/i/${r.itemId}`} className="btn btn-ghost btn-sm action-view">View</Link>
                      <form action={completeServiceAction}>
                        <input type="hidden" name="id" value={r.id} />
                        <input type="hidden" name="itemId" value={r.itemId} />
                        <button type="submit" className="btn btn-secondary btn-sm">Mark Completed</button>
                      </form>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
