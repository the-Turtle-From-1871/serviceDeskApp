/**
 * The sort-key vocabulary, in a LEAF module.
 *
 * Why it lives here and not in items.service: both the server service and the
 * client table need this list, but items.service imports Prisma and is marked
 * `server-only`, so a client module (or a client unit test) that reached for it
 * would boot a database client to read nine strings. Keeping the vocabulary in
 * a dependency-free file lets both sides derive from ONE definition instead of
 * hand-maintaining parallel copies that drift silently — a key offered in the
 * UI but unknown to the server is dropped by parseSortKeys, so the user picks a
 * sort and the table just reorders into the default order with no error.
 *
 * SORT_COLUMN is also the ALLOWLIST guarding a SQL-identifier interpolation
 * (the ORDER BY splice in readinessOrderedItemIds), which is why it is frozen
 * and why callers must resolve through `columnForKey` rather than indexing it.
 */

/** Physical column each NON-derived sort key orders by.
 *
 *  `auditState` is DERIVED and has no like-named column — it resolves to the
 *  denormalized `lastAuditedAt`. A key shared by the Prisma path and the raw
 *  path must sort identically on both, so both read it from here.
 *
 *  Frozen at runtime: `Readonly` alone is erased at compile time and an
 *  importer could `Object.assign` the injection boundary wider. */
const SORT_COLUMN_MAP = Object.freeze({
  deviceName: "deviceName",
  make: "make",
  model: "model",
  serialNumber: "serialNumber",
  status: "status",
  auditState: "lastAuditedAt",
  deviceUIC: "deviceUIC",
  deviceCategory: "deviceCategory",
} as const);

/** Widened for lookup by an arbitrary string (always via `columnForKey`), while
 *  SORT_COLUMN_MAP keeps its literal keys so `SortField` below stays a real
 *  union the client's column list is checked against. */
export const SORT_COLUMN: Readonly<Record<string, string>> = SORT_COLUMN_MAP;

/** The one key with no column at all: it sends the whole query down the raw-SQL
 *  path, ordered by READINESS_RANK. */
export const READINESS_SORT_KEY = "readiness";

/** Every server-sortable key, DERIVED from SORT_COLUMN rather than hand-listed.
 *
 *  These used to be two parallel lists, and a key added to one but not the
 *  other was a 500 on the raw path reachable only via `?sort=readiness,<key>`,
 *  so every single-key test missed it. Deriving makes that desync
 *  unrepresentable.
 *
 *  NOTE the `ReadonlySet` type is a COMPILE-TIME claim only — a Set's contents
 *  are internal slots, so neither the type nor `Object.freeze` prevents
 *  `.add()` at runtime. The actual runtime guard on the SQL boundary is
 *  `columnForKey`'s `Object.hasOwn(SORT_COLUMN, key)` check, not this. */
export const ITEM_SORT_COLUMNS: ReadonlySet<string> = new Set([
  ...Object.keys(SORT_COLUMN),
  READINESS_SORT_KEY,
]);

/** Sort keys as a union, so the client's column list is checked at compile time
 *  instead of only by a runtime test. */
export type SortField = keyof typeof SORT_COLUMN_MAP | typeof READINESS_SORT_KEY;
