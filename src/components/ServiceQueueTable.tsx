"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { completeServiceAction } from "@/app/admin/actions/queue";
import { makeStore, usePersistedPref } from "@/components/persisted-pref";
import { DueBadge } from "@/components/DueBadge";
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
          <table className="table">
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
                <tr key={r.id}>
                  {!isHidden("serialNumber") && <td className="mono" data-label="SN">{r.serialNumber}</td>}
                  {!isHidden("deviceName") && <td data-label="Device Name">{r.deviceName ? r.deviceName : <span className="subtle">—</span>}</td>}
                  {!isHidden("homeUnit") && <td data-label="Unit">{r.homeUnit ? r.homeUnit : <span className="subtle">—</span>}</td>}
                  {!isHidden("serviceType") && <td data-label="Service Type">{r.serviceType}</td>}
                  {!isHidden("due") && <td data-label="Due"><DueBadge dueAt={r.dueAt} /></td>}
                  <td data-label="">
                    <div className="actions actions--end">
                      <Link href={`/i/${r.itemId}`} className="btn btn-ghost btn-sm">View</Link>
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
