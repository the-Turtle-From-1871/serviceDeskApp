import {
  sortRows,
  parseSortPref,
  parseHiddenCols,
  type SortDir,
  type SortPref,
} from "@/components/column-view";

export type { SortDir };

export type QueueSortField = "serialNumber" | "deviceName" | "homeUnit" | "serviceType" | "due";

export type QueueRowVM = {
  id: string;
  itemId: string;
  serialNumber: string;
  deviceName: string | null;
  homeUnit: string | null;
  serviceType: string; // display label
  serviceTypeRaw: "REIMAGE" | "REPAIR" | "OTHER"; // for filtering
  dueAt: string | null; // ISO; null = no timer
};

export type QueueSortPref = SortPref<QueueSortField>;
export type QueueTypeFilter = "ALL" | "REIMAGE" | "REPAIR" | "OTHER";

export const QUEUE_COLUMNS: { key: QueueSortField; label: string }[] = [
  { key: "serialNumber", label: "SN" },
  { key: "deviceName", label: "Device Name" },
  { key: "homeUnit", label: "Unit" },
  { key: "serviceType", label: "Service Type" },
  { key: "due", label: "Due" },
];

const SORT_FIELDS = new Set<string>(QUEUE_COLUMNS.map((c) => c.key));

const SORT_LABEL = new Map<string, string>(QUEUE_COLUMNS.map((c) => [c.key, c.label]));

/** The service-type filter's options, including its neutral entry. Exported so
 *  the toolbar and the summary below read the SAME labels — a second copy is how
 *  the trigger ends up naming a filter the select does not offer. */
export const QUEUE_TYPE_FILTERS: { value: QueueTypeFilter; label: string }[] = [
  { value: "ALL", label: "All types" },
  { value: "REIMAGE", label: "Reimage" },
  { value: "REPAIR", label: "Repair" },
  { value: "OTHER", label: "Other" },
];

const TYPE_LABEL = new Map<string, string>(QUEUE_TYPE_FILTERS.map((f) => [f.value, f.label]));

/** The text the queue's "Sort & filter" trigger reads back, so the current sort
 *  and service-type filter stay legible with the menu closed. Mirrors
 *  `sortFilterSummary` in items-view — same shape, this page's vocabulary.
 *
 *  "ALL" is the neutral filter here (not ""), so it appends nothing. An
 *  unrecognised sort key reads as "Newest", matching what sortQueueRows actually
 *  does with one: `sortRows` leaves the rows in their incoming order, so
 *  claiming a sort that is not applied would be a confident wrong answer. */
export function queueSortFilterSummary(
  sort: string | null,
  dir: SortDir,
  type: QueueTypeFilter,
): string {
  const label = sort ? SORT_LABEL.get(sort) : undefined;
  const sortPart = label ? `${label} ${dir === "asc" ? "▲" : "▼"}` : "Newest";
  return type !== "ALL" ? `${sortPart} · ${TYPE_LABEL.get(type) ?? type}` : sortPart;
}

export function sortQueueRows(rows: QueueRowVM[], field: QueueSortField | null, dir: SortDir): QueueRowVM[] {
  if (field === "due") {
    const sign = dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      // Nulls (no timer) always sort last regardless of direction.
      if (a.dueAt === null && b.dueAt === null) return 0;
      if (a.dueAt === null) return 1;
      if (b.dueAt === null) return -1;
      return sign * (Date.parse(a.dueAt) - Date.parse(b.dueAt));
    });
  }
  return sortRows(rows, field, dir);
}

/** Client-side search (SN / Device Name / Unit) + service-type filter. */
export function filterQueueRows(rows: QueueRowVM[], opts: { search: string; type: QueueTypeFilter }): QueueRowVM[] {
  const q = opts.search.trim().toLowerCase();
  return rows.filter((r) => {
    if (opts.type !== "ALL" && r.serviceTypeRaw !== opts.type) return false;
    if (!q) return true;
    const hay = [r.serialNumber, r.deviceName ?? "", r.homeUnit ?? ""].join(" ").toLowerCase();
    return hay.includes(q);
  });
}

export function parseQueueSort(raw: string | null): QueueSortPref {
  return parseSortPref<QueueSortField>(raw, SORT_FIELDS);
}

export function parseQueueHidden(raw: string | null): QueueSortField[] {
  return parseHiddenCols<QueueSortField>(raw, SORT_FIELDS, QUEUE_COLUMNS.length);
}
