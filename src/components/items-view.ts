import { sortRows, parseSortPref as parseSortPrefGeneric, parseHiddenCols as parseHiddenColsGeneric, type SortDir, type SortPref as GenericSortPref } from "@/components/column-view";
import type { AuditState } from "@/modules/audit/audit.status";
import { READINESS_LABEL, type ReadinessState } from "@/modules/items/readiness";

export type { SortDir };

/** Columns the SERVER can order by. Most map to a stored column; `auditState`
 *  and `readiness` are derived and route through listItems' own mappings (a
 *  denormalized column and a raw-SQL ORDER BY respectively).
 *
 *  Re-exported from the leaf module the SERVER derives its allowlist from, so
 *  the two cannot drift: a column offered here that parseSortKeys does not
 *  accept is now a compile error rather than a sort that silently falls back to
 *  the default order. `sort-keys` imports nothing, so this pulls no Prisma into
 *  the client bundle. */
export type { SortField } from "@/modules/items/sort-keys";
import type { SortField } from "@/modules/items/sort-keys";

/** Every column the table can render.
 *
 *  NO LONGER identical to SortField. `holder` is displayed but not
 *  server-sortable: the current holder comes from a two-join custody lookup
 *  (modules/transfers/holders.query.ts) with no column for Prisma to name, and
 *  it is deliberately NOT a third derived sort key — that would mean a scalar
 *  subquery in the raw ORDER BY, its own parity coverage and a nulls decision.
 *  Sortability is the SORTABLE_COLUMNS list below; visibility is this one. */
export type ColumnKey = SortField | "holder";

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
  /** The recipient named on this item's current hand receipt — open, with this
   *  row unreturned. Null when nothing holds it. Derived server-side for the
   *  whole page in one query — never per row. See
   *  modules/transfers/holders.query.ts. */
  holderName: string | null;
};

export type SortPref = GenericSortPref<SortField>;

export const ITEM_COLUMNS: { key: ColumnKey; label: string }[] = [
  { key: "deviceName", label: "Device Name" },
  { key: "make", label: "Make" },
  { key: "model", label: "Model" },
  { key: "serialNumber", label: "Serial" },
  { key: "holder", label: "Holder" },
  { key: "deviceUIC", label: "UIC" },
  { key: "deviceCategory", label: "Category" },
  { key: "readiness", label: "Readiness" },
  { key: "status", label: "Status" },
  { key: "auditState", label: "Audit" },
];

/** The Sort control's options — every column EXCEPT `holder`.
 *
 *  This used to be `ITEM_COLUMNS` itself, on the invariant that the table shows
 *  nothing it cannot also sort. `holder` breaks that invariant deliberately (see
 *  ColumnKey), so the two lists diverge here rather than offering a sort the
 *  server would silently drop: parseSortKeys does not accept `holder`, so a
 *  `?sort=holder` URL falls back to the default order with no error. */
export const SORTABLE_COLUMNS: { key: SortField; label: string }[] = ITEM_COLUMNS.filter(
  (c): c is { key: SortField; label: string } => c.key !== "holder",
);

const SORT_FIELDS = new Set<string>(SORTABLE_COLUMNS.map((c) => c.key));
// Visibility and sortability are separate CONCEPTS on purpose: hiding a column
// must never imply you cannot sort by it. They also now differ in MEMBERSHIP —
// COLUMN_KEYS has 10 keys (including "holder"), SORT_FIELDS has 9 — because
// `holder` is displayable but not server-sortable (see SORTABLE_COLUMNS above).
const COLUMN_KEYS = new Set<string>(ITEM_COLUMNS.map((c) => c.key));

/** Client-side ordering of rows already in hand. The /items table does NOT use
 *  it — sorting there is server-side so it acts over the whole catalogue, not
 *  one page — so note that this orders `readiness` by its raw state string,
 *  which is not the operational sequence listItems sorts by (READINESS_ORDER). */
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
