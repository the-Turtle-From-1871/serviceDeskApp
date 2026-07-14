import {
  sortRows,
  parseSortPref,
  parseHiddenCols,
  type SortDir,
  type SortPref,
} from "@/components/column-view";

export type { SortDir };

export type QueueSortField = "serialNumber" | "deviceName" | "homeUnit" | "serviceType";

export type QueueRowVM = {
  id: string;
  itemId: string;
  serialNumber: string;
  deviceName: string | null;
  homeUnit: string | null;
  serviceType: string; // display label
  serviceTypeRaw: "REIMAGE" | "REPAIR" | "OTHER"; // for filtering
};

export type QueueSortPref = SortPref<QueueSortField>;
export type QueueTypeFilter = "ALL" | "REIMAGE" | "REPAIR" | "OTHER";

export const QUEUE_COLUMNS: { key: QueueSortField; label: string }[] = [
  { key: "serialNumber", label: "SN" },
  { key: "deviceName", label: "Device Name" },
  { key: "homeUnit", label: "Unit" },
  { key: "serviceType", label: "Service Type" },
];

const SORT_FIELDS = new Set<string>(QUEUE_COLUMNS.map((c) => c.key));

export function sortQueueRows(rows: QueueRowVM[], field: QueueSortField | null, dir: SortDir): QueueRowVM[] {
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
