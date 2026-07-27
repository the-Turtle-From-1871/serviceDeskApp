import { sortRows, parseSortPref as parseSortPrefGeneric, parseHiddenCols as parseHiddenColsGeneric, type SortDir, type SortPref as GenericSortPref } from "@/components/column-view";
import type { AuditState } from "@/modules/audit/audit.status";
import { READINESS_LABEL, type ReadinessState } from "@/modules/items/readiness";

export type { SortDir };

/** Columns the SERVER can order by — every one maps to a stored column (see
 *  listItems). Readiness is deliberately absent; see COLUMN_KEY below. */
export type SortField =
  | "deviceName"
  | "make"
  | "model"
  | "serialNumber"
  | "status"
  | "auditState"
  | "deviceUIC"
  | "deviceCategory";

/** Every column the table can render. A superset of SortField: `readiness` is
 *  DISPLAY-ONLY. It is derived from four signals across three tables
 *  (modules/items/readiness.ts), so there is no column to ORDER BY — offering
 *  it in the Sort control would either need a stored duplicate that drifts or
 *  a per-page sort that lies about the other 1,100 rows. */
export type ColumnKey = SortField | "readiness";

/* Readiness labels have ONE definition, in modules/items/readiness.ts, next to
   the function that derives them. Re-exported here so the table imports its
   vocabulary from this module like everything else, without a second copy that
   could drift. */
export { READINESS_LABEL };
export type { ReadinessState };

export type ItemRow = {
  id: string;
  deviceName: string | null;
  make: string;
  model: string;
  serialNumber: string;
  status: "ACTIVE" | "RETIRED";
  auditState: AuditState | null;
  deviceUIC: string | null;
  deviceCategory: string | null;
  /** Derived server-side for the whole page in one query — never per row.
   *  See modules/items/readiness.query.ts. */
  readiness: ReadinessState;
};

export type SortPref = GenericSortPref<SortField>;

export const ITEM_COLUMNS: { key: ColumnKey; label: string }[] = [
  { key: "deviceName", label: "Device Name" },
  { key: "make", label: "Make" },
  { key: "model", label: "Model" },
  { key: "serialNumber", label: "Serial" },
  { key: "deviceUIC", label: "UIC" },
  { key: "deviceCategory", label: "Category" },
  { key: "readiness", label: "Readiness" },
  { key: "status", label: "Status" },
  { key: "auditState", label: "Audit" },
];

/** The Sort control's options: every column except the display-only ones. */
export const SORTABLE_COLUMNS: { key: SortField; label: string }[] = ITEM_COLUMNS.filter(
  (c): c is { key: SortField; label: string } => c.key !== "readiness",
);

const SORT_FIELDS = new Set<string>(SORTABLE_COLUMNS.map((c) => c.key));
// Column visibility covers EVERY column, sortable or not — a readiness column
// you cannot sort is still one you can hide.
const COLUMN_KEYS = new Set<string>(ITEM_COLUMNS.map((c) => c.key));

export function sortItemRows(items: ItemRow[], field: SortField | null, dir: SortDir): ItemRow[] {
  return sortRows(items, field, dir);
}

export function parseSortPref(raw: string | null): SortPref {
  return parseSortPrefGeneric<SortField>(raw, SORT_FIELDS);
}

/** Ids of the rows a user can actually select. Retired items render no
 *  checkbox, so they can never be part of a selection. */
export function selectableIds(items: ItemRow[]): string[] {
  return items.filter((it) => it.status === "ACTIVE").map((it) => it.id);
}

export type SelectAllState = "none" | "some" | "all";

/** Tri-state for the header checkbox, derived from the selectable rows only.
 *  A list with nothing selectable is always "none" — never "all" — so the
 *  header box cannot claim a selection that no row could hold. */
export function selectAllState(items: ItemRow[], selected: ReadonlySet<string>): SelectAllState {
  const ids = selectableIds(items);
  if (ids.length === 0) return "none";
  const hits = ids.filter((id) => selected.has(id)).length;
  if (hits === 0) return "none";
  return hits === ids.length ? "all" : "some";
}

export function parseHiddenCols(raw: string | null): ColumnKey[] {
  return parseHiddenColsGeneric<ColumnKey>(raw, COLUMN_KEYS, ITEM_COLUMNS.length);
}
