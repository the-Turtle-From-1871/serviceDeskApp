import { sortRows, parseSortPref as parseSortPrefGeneric, parseHiddenCols as parseHiddenColsGeneric, type SortDir, type SortPref as GenericSortPref } from "@/components/column-view";
import type { AuditState } from "@/modules/audit/audit.status";

export type { SortDir };

export type SortField =
  | "deviceName"
  | "make"
  | "model"
  | "serialNumber"
  | "status"
  | "auditState"
  | "deviceUIC"
  | "deviceCategory"
  | "deployableStatus";

/** The four readiness states plus the untriaged bucket, in the order they are
 *  grouped and displayed. Kept in sync with the Prisma DeployableStatus enum;
 *  `null` (never triaged) renders last under UNTRIAGED. */
export const DEPLOYABLE_ORDER = [
  "DEPLOYED",
  "READY_TO_DEPLOY",
  "IN_REPAIR",
  "RETIRED",
  "UNTRIAGED",
] as const;

export type DeployableKey = (typeof DEPLOYABLE_ORDER)[number];

export const DEPLOYABLE_LABEL: Record<DeployableKey, string> = {
  DEPLOYED: "Deployed",
  READY_TO_DEPLOY: "Ready to deploy",
  IN_REPAIR: "In repair",
  RETIRED: "Retired",
  UNTRIAGED: "Untriaged",
};

export const deployableKey = (s: string | null | undefined): DeployableKey =>
  s && (DEPLOYABLE_ORDER as readonly string[]).includes(s) ? (s as DeployableKey) : "UNTRIAGED";

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
  deployableStatus: string | null;
  isAccountedFor: boolean;
};

export type SortPref = GenericSortPref<SortField>;

export const ITEM_COLUMNS: { key: SortField; label: string }[] = [
  { key: "deviceName", label: "Device Name" },
  { key: "make", label: "Make" },
  { key: "model", label: "Model" },
  { key: "serialNumber", label: "Serial" },
  { key: "deviceUIC", label: "UIC" },
  { key: "deviceCategory", label: "Category" },
  { key: "deployableStatus", label: "Readiness" },
  { key: "status", label: "Status" },
  { key: "auditState", label: "Audit" },
];

/** Consecutive runs of rows sharing a readiness state, for group headers.
 *  Relies on the server having ORDER BY'd by deployableStatus first, so this
 *  is a single pass over the page — it never re-sorts or re-queries. */
export function groupByReadiness(items: ItemRow[]): { key: DeployableKey; rows: ItemRow[] }[] {
  const groups: { key: DeployableKey; rows: ItemRow[] }[] = [];
  for (const item of items) {
    const key = deployableKey(item.deployableStatus);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.rows.push(item);
    else groups.push({ key, rows: [item] });
  }
  return groups;
}

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
