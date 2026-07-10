export type SortField = "deviceName" | "make" | "model" | "serialNumber" | "status";
export type SortDir = "asc" | "desc";

export type ItemRow = {
  id: string;
  deviceName: string | null;
  make: string;
  model: string;
  serialNumber: string;
  status: "ACTIVE" | "RETIRED";
};

export type SortPref = { field: SortField | null; dir: SortDir };

export const ITEM_COLUMNS: { key: SortField; label: string }[] = [
  { key: "deviceName", label: "Device Name" },
  { key: "make", label: "Make" },
  { key: "model", label: "Model" },
  { key: "serialNumber", label: "Serial" },
  { key: "status", label: "Status" },
];

const SORT_FIELDS = new Set<string>(ITEM_COLUMNS.map((c) => c.key));
const DEFAULT_SORT: SortPref = { field: null, dir: "asc" };

/** Case-insensitive sort by a field. Null/blank values sort last in both
 *  directions. Returns a new array; the input is not mutated. */
export function sortItemRows(items: ItemRow[], field: SortField | null, dir: SortDir): ItemRow[] {
  const copy = items.slice();
  if (!field) return copy;
  copy.sort((a, b) => {
    const av = a[field];
    const bv = b[field];
    const aBlank = av == null || av === "";
    const bBlank = bv == null || bv === "";
    if (aBlank && bBlank) return 0;
    if (aBlank) return 1;
    if (bBlank) return -1;
    const base = String(av).localeCompare(String(bv), undefined, { sensitivity: "base" });
    return dir === "asc" ? base : -base;
  });
  return copy;
}

export function parseSortPref(raw: string | null): SortPref {
  if (!raw) return DEFAULT_SORT;
  try {
    const v = JSON.parse(raw) as { field?: unknown; dir?: unknown };
    const field = typeof v.field === "string" && SORT_FIELDS.has(v.field) ? (v.field as SortField) : null;
    const dir = v.dir === "desc" ? "desc" : v.dir === "asc" ? "asc" : null;
    if (!dir) return DEFAULT_SORT;
    return { field, dir };
  } catch {
    return DEFAULT_SORT;
  }
}

export function parseHiddenCols(raw: string | null): SortField[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    const cols = v.filter((k): k is SortField => typeof k === "string" && SORT_FIELDS.has(k));
    // Never hide every data column — that would leave a column-less table.
    if (cols.length >= ITEM_COLUMNS.length) return [];
    return cols;
  } catch {
    return [];
  }
}
