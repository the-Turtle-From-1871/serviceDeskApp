import { sortRows, parseSortPref as parseSortPrefGeneric, parseHiddenCols as parseHiddenColsGeneric, type SortDir, type SortPref as GenericSortPref } from "@/components/column-view";
import type { AuditState } from "@/modules/audit/audit.status";

export type { SortDir };

export type SortField = "deviceName" | "make" | "model" | "serialNumber" | "status" | "auditState";

export type ItemRow = {
  id: string;
  deviceName: string | null;
  make: string;
  model: string;
  serialNumber: string;
  status: "ACTIVE" | "RETIRED";
  auditState: AuditState | null;
};

export type SortPref = GenericSortPref<SortField>;

export const ITEM_COLUMNS: { key: SortField; label: string }[] = [
  { key: "deviceName", label: "Device Name" },
  { key: "make", label: "Make" },
  { key: "model", label: "Model" },
  { key: "serialNumber", label: "Serial" },
  { key: "status", label: "Status" },
  { key: "auditState", label: "Audit" },
];

const SORT_FIELDS = new Set<string>(ITEM_COLUMNS.map((c) => c.key));

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

export function parseHiddenCols(raw: string | null): SortField[] {
  return parseHiddenColsGeneric<SortField>(raw, SORT_FIELDS, ITEM_COLUMNS.length);
}
