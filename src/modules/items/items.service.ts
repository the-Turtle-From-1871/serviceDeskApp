// Prisma is a VALUE import here, not type-only: the batched import UPDATE uses
// Prisma.sql / Prisma.join / Prisma.raw to build a parameterized statement.
import { Prisma } from "@prisma/client";
import type { Item, ItemStatus } from "@prisma/client";
import prisma from "@/lib/prisma";
import { newItemSchema, type NewItemInput } from "./items.schema";
import { parseItemsCsv } from "./csv";
import { planImport, type SkippedRow, type UnresolvedRow, type ExistingItem, type ItemUpdate } from "./import";
import { loadUnitMap, learnUnits, type UnitResolution } from "./units.service";
import { diffItemFields, type ItemLoggedFields } from "./item-diff";
import { learnCategories } from "./categories.service";
import { READINESS_JOINS, READINESS_RANK } from "./readiness.sql";
import { ItemError } from "./items.errors";

export async function createItem(input: NewItemInput, createdById: string): Promise<Item> {
  const data = newItemSchema.parse(input);
  // No history row, and no transaction to hold one: readiness is derived from
  // live signals (service queue, open receipts, MDM last-logon, markedReadyAt),
  // so a brand-new item has nothing to record. It simply reads "Untriaged"
  // until one of those signals appears.
  return prisma.item.create({ data: { ...data, createdById } });
}

export function getItem(id: string) {
  return prisma.item.findUnique({ where: { id } });
}

// Just the fields needed to render a QR label — avoids pulling admin-only
// columns (e.g. `notes`) on the logged-in QR-PDF route under the public /i path.
export function getItemQrFields(id: string) {
  return prisma.item.findUnique({ where: { id }, select: { id: true, serialNumber: true } });
}

export async function getItemsByIds(ids: string[]): Promise<Item[]> {
  if (ids.length === 0) return [];
  const found = await prisma.item.findMany({ where: { id: { in: ids } } });
  // Preserve the caller's requested order (findMany does not guarantee it).
  const byId = new Map(found.map((i) => [i.id, i]));
  return ids.map((id) => byId.get(id)).filter((i): i is Item => !!i);
}

export function getItemWithCreator(id: string) {
  return prisma.item.findUnique({
    where: { id },
    include: { createdBy: { select: { rank: true, name: true } } },
  });
}

// Server-sortable sort keys. Two of them are DERIVED and have no like-named
// column: `auditState` maps to the denormalized `lastAuditedAt` (audit recency
// IS audit-status severity), and `readiness` has no column at all — it sends
// the whole query down the raw-SQL path below. The rest map straight to their
// like-named Item columns.
const ITEM_SORT_COLUMNS = new Set([
  "deviceName",
  "make",
  "model",
  "serialNumber",
  "status",
  "auditState",
  "deviceUIC",
  "deviceCategory",
  "readiness",
]);

export const ITEMS_PAGE_SIZE = 50;

/** Compound sort is capped so a crafted querystring can't push an unbounded
 *  ORDER BY list (each key is a real index-less sort in the worst case). */
export const MAX_SORT_KEYS = 3;

export type SortKey = { key: string; dir: "asc" | "desc" };

export type ItemsPage = {
  items: Item[];
  total: number;
  page: number;
  pageSize: number;
  sort: string | null;
  dir: "asc" | "desc";
  /** The full parsed compound sort; `sort`/`dir` above are its first key,
   *  kept for the existing single-key callers and links. */
  sortKeys: SortKey[];
  uic: string | null;
};

/**
 * Parse the URL's compound sort into an ordered key list.
 *
 * `?sort=make,serialNumber&dir=asc,desc` -> [{make asc}, {serialNumber desc}].
 * A missing dir entry defaults to the FIRST key's direction rather than to
 * "desc", so `?sort=make,serialNumber&dir=asc` sorts both ascending — which is
 * what someone typing that by hand means. Unknown columns are dropped (never
 * passed to Prisma), and duplicates collapse to their first occurrence so
 * `sort=make,make` can't produce a contradictory ORDER BY.
 */
export function parseSortKeys(sort: string | null | undefined, dir: string | null | undefined): SortKey[] {
  if (!sort) return [];
  const dirs = (dir ?? "").split(",").map((d) => (d.trim() === "asc" ? "asc" : d.trim() === "desc" ? "desc" : null));
  const fallback = dirs[0] ?? "desc";
  const seen = new Set<string>();
  const keys: SortKey[] = [];
  for (const [i, raw] of sort.split(",").entries()) {
    const key = raw.trim();
    if (!key || !ITEM_SORT_COLUMNS.has(key) || seen.has(key)) continue;
    seen.add(key);
    keys.push({ key, dir: dirs[i] ?? fallback });
    if (keys.length >= MAX_SORT_KEYS) break;
  }
  return keys;
}

/** Map one sort key to a Prisma orderBy clause. `auditState` is derived and
 *  time-dependent, so it rides the denormalized `lastAuditedAt` column; the
 *  two nullable columns sort their empties last in BOTH directions, so an
 *  untriaged/unassigned row never outranks a real value. */
function orderClauseFor({ key, dir }: SortKey): Prisma.ItemOrderByWithRelationInput {
  if (key === "auditState") return { lastAuditedAt: { sort: dir, nulls: "last" } };
  if (key === "deviceUIC") return { deviceUIC: { sort: dir, nulls: "last" } };
  if (key === "deviceCategory") return { deviceCategory: { sort: dir, nulls: "last" } };
  return { [key]: dir } as Prisma.ItemOrderByWithRelationInput;
}

/** Physical column each NON-derived sort key orders by on the raw path.
 *
 *  This is an ALLOWLIST guarding a SQL-identifier interpolation, the same job
 *  UPDATABLE_ITEM_COLUMNS does for the importer: the column name is spliced
 *  into the ORDER BY (values never are), so nothing outside this map may reach
 *  it. `auditState` resolves to `lastAuditedAt` exactly as orderClauseFor does
 *  — a key shared by both paths must sort identically on both, or adding
 *  readiness to a compound sort would quietly change what the other keys mean. */
const SORT_COLUMN: Record<string, string> = {
  deviceName: "deviceName",
  make: "make",
  model: "model",
  serialNumber: "serialNumber",
  status: "status",
  auditState: "lastAuditedAt",
  deviceUIC: "deviceUIC",
  deviceCategory: "deviceCategory",
};

/** Keys whose empties sort last in BOTH directions, mirroring orderClauseFor's
 *  `nulls: "last"`. Every other key is left to Postgres's default (NULLS LAST
 *  ascending, NULLS FIRST descending) — which is exactly what a bare Prisma
 *  `{ column: dir }` emits, so the two paths agree without saying so twice. */
const NULLS_LAST_SORT_KEYS = new Set(["auditState", "deviceUIC", "deviceCategory"]);

/** The raw-SQL twin of listItems' Prisma `where`.
 *
 *  WHY THIS IS THE RISKY PART: two filter implementations drift, and a drifted
 *  filter shows a different catalogue depending on which column you sorted by.
 *  `items.readiness-sort.parity.test.ts` seeds real rows and asserts both paths
 *  return the same ids in the same order for the same filters, so a change made
 *  here and not there fails a test rather than a user.
 *
 *  `"serialNumber"::text ILIKE` is not stylistic: the column is citext, whose
 *  own ILIKE operator the text pg_trgm GIN index cannot serve (see
 *  searchItemsBySerial). LIKE metacharacters are deliberately NOT escaped here
 *  — Prisma's `contains` does not escape them either, and matching the path
 *  this stands in for matters more than tightening one of the two.
 *
 *  Values are BOUND, never interpolated (CLAUDE.md §2); the `::text IS NULL`
 *  guards let one statement serve every filter combination, as itemScopeSql
 *  does for the dashboard. */
function itemFilterSql(search: string | null, uic: string | null): Prisma.Sql {
  const pattern = search ? `%${search}%` : null;
  return Prisma.sql`
    (${pattern}::text IS NULL
      OR i."deviceName" ILIKE ${pattern}::text
      OR i."make" ILIKE ${pattern}::text
      OR i."model" ILIKE ${pattern}::text
      OR i."serialNumber"::text ILIKE ${pattern}::text)
    AND (${uic}::text IS NULL OR i."deviceUIC" = ${uic}::text)`;
}

/**
 * ONE page of item ids, ordered by a sort that involves readiness.
 *
 * Readiness has no column for Prisma to `orderBy` — but Postgres can derive it
 * inline from the same CASE the badge and the dashboard read, ranked by
 * READINESS_RANK. Selecting ids ONLY keeps this cheap and lets getItemsByIds
 * hydrate the page: two bounded queries for the whole list, never a derivation
 * per row.
 *
 * LIMIT/OFFSET carry the page-size cap over from the Prisma path, and the `id`
 * tie-break is repeated for the reason it exists there — readiness has five
 * distinct values across 1,200+ rows, so without a total order a row could
 * appear on two pages or on none.
 */
async function readinessOrderedItemIds(opts: {
  search: string | null;
  uic: string | null;
  sortKeys: SortKey[];
  skip: number;
  take: number;
}): Promise<string[]> {
  const terms: Prisma.Sql[] = [];
  for (const { key, dir } of opts.sortKeys) {
    const direction = Prisma.raw(dir === "asc" ? "ASC" : "DESC");
    if (key === "readiness") {
      terms.push(Prisma.sql`${READINESS_RANK} ${direction}`);
      continue;
    }
    const column = SORT_COLUMN[key];
    // parseSortKeys already dropped anything unknown; this re-checks at the SQL
    // boundary so a future caller that builds SortKeys some other way cannot
    // splice an identifier of its own choosing into the ORDER BY.
    if (!column) throw new ItemError("INVALID", `Refusing to sort by unknown column: ${key}`);
    const ref = Prisma.raw(`i."${column}"`);
    terms.push(
      NULLS_LAST_SORT_KEYS.has(key)
        ? Prisma.sql`${ref} ${direction} NULLS LAST`
        : Prisma.sql`${ref} ${direction}`,
    );
  }
  terms.push(Prisma.sql`i."id" ASC`);

  const rows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT i."id"
    FROM "Item" i
    ${READINESS_JOINS}
    WHERE ${itemFilterSql(opts.search, opts.uic)}
    ORDER BY ${Prisma.join(terms, ", ")}
    LIMIT ${opts.take} OFFSET ${opts.skip}`);
  return rows.map((r) => r.id);
}

// Paginated, sorted item list. Bounds the fetch and the RSC payload (the table was
// previously unbounded — every row shipped to the client on each load). Sort and
// paging are server-side so they act over the whole result set, not just one page.
export async function listItems(opts: {
  search?: string;
  sort?: string | null;
  dir?: string | null;
  page?: number;
  pageSize?: number;
  /** Filter to one issuing unit. Blank/absent = every unit. */
  uic?: string | null;
} = {}): Promise<ItemsPage> {
  const pageSize = opts.pageSize && opts.pageSize > 0 ? Math.floor(opts.pageSize) : ITEMS_PAGE_SIZE;
  const search = opts.search?.trim();
  const uic = opts.uic?.trim() || null;

  const filters: Prisma.ItemWhereInput[] = [];
  if (search) {
    filters.push({
      OR: [
        { deviceName: { contains: search, mode: "insensitive" } },
        { make: { contains: search, mode: "insensitive" } },
        { model: { contains: search, mode: "insensitive" } },
        { serialNumber: { contains: search, mode: "insensitive" } },
      ],
    });
  }
  if (uic) filters.push({ deviceUIC: uic });
  const where: Prisma.ItemWhereInput | undefined =
    filters.length === 0 ? undefined : filters.length === 1 ? filters[0] : { AND: filters };

  const sortKeys = parseSortKeys(opts.sort, opts.dir);

  // Readiness sorts through a SEPARATE, raw-SQL path — not because it is
  // special, but because it is derived from four signals across three tables
  // (readiness.ts) and so has no column for a Prisma `orderBy` to name. The two
  // alternatives were worse: a stored copy on Item is the `deployableStatus`
  // column that was deliberately dropped for drifting, and sorting a fetched
  // page in JavaScript would order 50 rows while claiming to order 1,200.
  // Postgres CAN order it — the same CASE the badge and the dashboard read —
  // so a sort that involves readiness selects its ids in SQL and hydrates them,
  // and every other sort stays on the untouched Prisma path below.
  const sortsByReadiness = sortKeys.some((k) => k.key === "readiness");

  // The chosen sort is the whole ORDER BY.
  const orderBy: Prisma.ItemOrderByWithRelationInput[] = [];
  if (!sortsByReadiness) {
    for (const k of sortKeys) orderBy.push(orderClauseFor(k));
    // Newest-first is the historical default; keep it when nothing else orders.
    if (sortKeys.length === 0) orderBy.push({ createdAt: "desc" });
    // Secondary key by id so rows with equal sort values keep a stable order across
    // pages (otherwise the same row can appear on two pages or none).
    orderBy.push({ id: "asc" });
  }

  // `total` comes from the Prisma count on BOTH paths, so the row count and the
  // pager can never disagree about which filter was applied.
  const total = await prisma.item.count({ where });
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Math.floor(opts.page ?? 1)), totalPages);
  const skip = (page - 1) * pageSize;
  const items = sortsByReadiness
    ? await getItemsByIds(
        await readinessOrderedItemIds({ search: search ?? null, uic, sortKeys, skip, take: pageSize }),
      )
    : await prisma.item.findMany({ where, orderBy, skip, take: pageSize });

  return {
    items,
    total,
    page,
    pageSize,
    sort: sortKeys[0]?.key ?? null,
    dir: sortKeys[0]?.dir ?? "desc",
    sortKeys,
    uic,
  };
}

/** Distinct UICs present in the catalogue, for a filter dropdown. ONE grouped
 *  query, capped. `scope` lets a caller narrow further — the readiness
 *  dashboard passes `{ status: "ACTIVE" }` because retired kit is out of scope
 *  there, while /items lists every unit. */
export async function listItemUics(
  limit = 200,
  scope: Prisma.ItemWhereInput = {},
): Promise<string[]> {
  const rows = await prisma.item.groupBy({
    by: ["deviceUIC"],
    where: { ...scope, deviceUIC: { not: null } },
    orderBy: { deviceUIC: "asc" },
    take: limit,
  });
  return rows.map((r) => r.deviceUIC).filter((u): u is string => u !== null);
}

export type ItemEditor = { id: string; name: string };

/** Columns the CSV importer may write in its batched UPDATE.
 *
 *  This is an ALLOWLIST guarding a SQL-identifier interpolation: column names
 *  are spliced into the statement (values are always bound), so nothing outside
 *  this set may reach it. It mirrors the loggable/telemetry field set that
 *  planImport emits — keep the two in step when adding an importable column. */
const UPDATABLE_ITEM_COLUMNS = new Set<string>([
  "make",
  "model",
  "serialNumber",
  "deviceName",
  "homeUnit",
  "deviceUIC",
  "deviceCategory",
  "notes",
  "currentUserEmail",
  "currentPosition",
  "lastLogonUserPrincipalName",
  "lastLogonDate",
  "lastLogonAt",
  "enrollmentDate",
  "compliance",
]);

/** Prisma FIELD name -> physical COLUMN name, for fields that differ.
 *
 *  The batched UPDATE is raw SQL, so it must name real columns. Prisma's
 *  `@map` means the field name and the column name can diverge:
 *  `currentUserEmail` is physically `"currentUser"`. Interpolating the field
 *  name produced `column "currentUserEmail" of relation "Item" does not exist`
 *  and failed any import that changed the assigned user. Add an entry here for
 *  every @map'd column the importer can write. */
const FIELD_TO_COLUMN: Record<string, string> = { currentUserEmail: "currentUser" };
const columnFor = (field: string) => FIELD_TO_COLUMN[field] ?? field;

/** Per-column cast for the batched UPDATE's VALUES list.
 *
 *  A cast is required so Postgres can type a column whose values are all NULL
 *  in a given chunk. Everything the importer writes is text EXCEPT the derived
 *  `lastLogonAt` instant — casting that to text would store a string in a
 *  timestamp column and fail the statement. */
const COLUMN_CAST: Record<string, string> = { lastLogonAt: "timestamptz" };
const castFor = (column: string) => COLUMN_CAST[column] ?? "text";

/** Rows per batched UPDATE statement. Keeps bind parameters well under
 *  Postgres's 65,535 ceiling (500 rows x 15 columns = 7,500) while keeping the
 *  round-trip count small. */
const UPDATE_CHUNK_ROWS = 500;

/** Hard cap on one bulk action. The UI selects at most a page at a time, but
 *  the action is reachable by POST, so the server bounds it too. */
export const MAX_BULK_ITEMS = 500;

/**
 * Mark items as back in our possession.
 *
 * This is the ONLY hand-set readiness signal; everything else is derived (see
 * modules/items/readiness.ts). It stamps `markedReadyAt = now`, which reads as
 * "Ready to deploy" until something contradicts it — an open hand receipt, a
 * service flag, or an MDM logon dated AFTER the stamp. That last case is why
 * this is a timestamp and not a boolean: the marking expires on its own once
 * the device is used again, instead of quietly going stale.
 *
 * Writes only rows that are not already marked at this instant, so re-running
 * it is a no-op rather than churn. There is no history table to keep in step
 * any more — the stamp itself is the record.
 *
 * Enforces NO permissions — the calling Server Action owns the admin guard.
 */
export async function markItemsReady(
  itemIds: string[],
  now: Date = new Date(),
): Promise<{ updated: number }> {
  const ids = [...new Set(itemIds.filter((id) => id.trim() !== ""))];
  if (ids.length === 0) return { updated: 0 };
  if (ids.length > MAX_BULK_ITEMS) throw new ItemError("TOO_MANY");

  // Retired kit is out of scope: "back on the shelf" is meaningless for a
  // device that has left the fleet, and readiness reports RETIRED regardless.
  const res = await prisma.item.updateMany({
    where: { id: { in: ids }, status: "ACTIVE" },
    data: { markedReadyAt: now },
  });
  return { updated: res.count };
}

/** Update an item's loggable fields and record ONE ItemEdit describing the diff,
 *  atomically. Writes no history row when nothing actually changed.
 *
 *  Enforces NO permissions and trusts `editor` — the calling Server Action owns
 *  the auth guard and the permitted field set. */
export async function updateItemFields(
  itemId: string,
  data: Partial<ItemLoggedFields>,
  editor: ItemEditor,
): Promise<Item> {
  return prisma.$transaction(async (tx) => {
    const before = await tx.item.findUnique({ where: { id: itemId } });
    if (!before) throw new ItemError("NOT_FOUND");

    const changes = diffItemFields(before, data);
    if (changes.length === 0) return before;

    const updated = await tx.item.update({
      where: { id: itemId },
      data: Object.fromEntries(changes.map((c) => [c.field, c.to])),
    });
    await tx.itemEdit.create({
      data: {
        itemId,
        editedById: editor.id,
        editedByName: editor.name,
        changes: changes as unknown as Prisma.InputJsonValue,
      },
    });
    return updated;
  });
}

export function setItemStatus(id: string, status: ItemStatus): Promise<Item> {
  return prisma.item.update({ where: { id }, data: { status } });
}

export function retireItem(id: string): Promise<Item> {
  return setItemStatus(id, "RETIRED");
}

export type SerialSearchHit = { id: string; make: string; model: string; serialNumber: string; status: ItemStatus };

export function searchItemsBySerial(q: string): Promise<SerialSearchHit[]> {
  const s = q.trim();
  if (!s) return Promise.resolve([]);
  // Raw with an explicit `"serialNumber"::text ILIKE` so the pg_trgm GIN index
  // (Item_serialNumber_trgm_idx) is used — a bare citext ILIKE uses citext's own
  // operator and falls back to a seq scan. The pattern is a bound PARAMETER (no
  // string-concatenation into the SQL, so no injection); LIKE metacharacters in the
  // term are escaped so they match literally. take 50 bounds the public result set.
  const term = s.replace(/[\\%_]/g, (m) => "\\" + m);
  return prisma.$queryRaw<SerialSearchHit[]>`
    SELECT "id", "make", "model", "serialNumber"::text AS "serialNumber", "status"::text AS "status"
    FROM "Item"
    WHERE "serialNumber"::text ILIKE ${`%${term}%`}
    ORDER BY "createdAt" DESC
    LIMIT 50`;
}

// One query pulls every column planImport needs to match + diff a row. Scoped to
// the serials actually in the CSV (`in` over the citext column, so it matches
// case-insensitively) — bounds the fetch to the upload size instead of the whole
// catalog. Keyed by lowercased serial to mirror the DB's citext identity.
async function loadExistingBySerial(serials: string[]): Promise<Map<string, ExistingItem>> {
  const wanted = serials.filter((s) => s.trim() !== "");
  if (wanted.length === 0) return new Map();
  const rows = await prisma.item.findMany({
    where: { serialNumber: { in: wanted } },
    select: {
      id: true, status: true, serialNumber: true, make: true, model: true, deviceName: true,
      deviceUIC: true, deviceCategory: true, currentUserEmail: true, lastLogonUserPrincipalName: true, lastLogonDate: true,
      enrollmentDate: true, compliance: true,
    },
  });
  const map = new Map<string, ExistingItem>();
  for (const r of rows) {
    const { serialNumber, ...rest } = r;
    map.set(serialNumber.toLowerCase(), rest);
  }
  return map;
}

// Make/model mismatch summary from a plan, for the UI warning list.
function collectMismatches(plan: { toUpdate: { serialNumber: string; makeModelMismatch: boolean }[]; unchanged: { serialNumber: string; makeModelMismatch: boolean }[] }): { serialNumber: string }[] {
  return [...plan.toUpdate, ...plan.unchanged]
    .filter((r) => r.makeModelMismatch)
    .map((r) => ({ serialNumber: r.serialNumber }));
}

export async function analyzeImport(text: string): Promise<{
  counts: { toImport: number; toUpdate: number; unchanged: number; skipped: number; autoDetected: number };
  skipped: SkippedRow[];
  unresolved: UnresolvedRow[];
  mismatches: { serialNumber: string }[];
  error?: string;
}> {
  const empty = { toImport: 0, toUpdate: 0, unchanged: 0, skipped: 0, autoDetected: 0 };
  const { rows, error } = parseItemsCsv(text);
  if (error) return { counts: empty, skipped: [], unresolved: [], mismatches: [], error };

  // Independent reads — run them together.
  const [existing, units] = await Promise.all([
    loadExistingBySerial(rows.map((r) => r.serialNumber)),
    loadUnitMap(),
  ]);
  const plan = planImport(rows, existing, units);

  return {
    counts: {
      toImport: plan.toCreate.length,
      toUpdate: plan.toUpdate.length,
      unchanged: plan.unchanged.length,
      skipped: plan.skipped.length,
      autoDetected: plan.detected,
    },
    skipped: plan.skipped,
    unresolved: plan.unresolved,
    mismatches: collectMismatches(plan),
  };
}

export async function commitImport(
  text: string,
  filename: string,
  resolutions: UnitResolution[],
  editor: { id: string; name: string }
): Promise<{ added: number; updated: number; skipped: SkippedRow[]; unchanged: number; detected: number; mismatches: { serialNumber: string }[]; error?: string }> {
  const { rows, error } = parseItemsCsv(text);
  if (error) return { added: 0, updated: 0, skipped: [], unchanged: 0, detected: 0, mismatches: [], error };

  // Persist learned units BEFORE planning so detection re-runs with the enriched map.
  await learnUnits(resolutions);

  // Independent reads — run them together (loadUnitMap must follow learnUnits above).
  const [existing, units] = await Promise.all([
    loadExistingBySerial(rows.map((r) => r.serialNumber)),
    loadUnitMap(),
  ]);
  const plan = planImport(rows, existing, units);
  const { toCreate, toUpdate, unchanged, skipped, detected } = plan;

  const { added, updated, skipped: finalSkipped } = await prisma.$transaction(async (tx) => {
    // Register any category the CSV introduced, the same way units are learned
    // above. The import is deliberately NOT blocked by an unknown category —
    // Item.deviceCategory has no FK — so this is what keeps the admin's managed
    // list a true reflection of what is actually in the fleet. One statement.
    //
    // Sourced from the rows actually WRITTEN, not from every parsed row: a row
    // rejected as invalid / duplicate-in-file / missing make+model never
    // reaches an item, so its category must not enter the vocabulary either
    // (an admin would then have to hand-delete a category nothing uses).
    await learnCategories(
      [
        ...toCreate.map((d) => d.deviceCategory),
        // `data` is a mixed column bag (the derived lastLogonAt is a Date), so
        // narrow to the text values learnCategories accepts rather than casting.
        ...toUpdate.map((u) => (typeof u.data.deviceCategory === "string" ? u.data.deviceCategory : null)),
      ],
      tx,
    );

    const created = await tx.item.createMany({
      // The DB unique(serialNumber, citext) is the race-safe backstop: skip rather
      // than throw on a serial a concurrent import inserted after loadExistingBySerial.
      data: toCreate.map((d) => ({ ...d, createdById: editor.id })),
      skipDuplicates: true,
    });

    // No baseline history is written for newly created rows. Readiness is
    // derived from live signals, so a fresh item needs no recorded starting
    // point — the import already stored the only thing that matters to it
    // (lastLogonUserPrincipalName / lastLogonAt, set above).

    // Updates are BATCHED, not one query per row.
    //
    // This used to loop `tx.item.updateMany` once per changed row. Locally that
    // is ~1.4ms a row and invisible; against a hosted database it is one network
    // round trip each, so a ~1,000-row fleet refresh became ~1,000 sequential
    // round trips — 15-40s depending on latency, against a 50s transaction
    // timeout and a 60s function limit. That is the "very large imports at high
    // DB latency" hazard the changelog flagged, and it is why a full re-import
    // could fail with a generic error while the same file imported fine locally.
    //
    // Prisma has no batch form for "different values per row", but SQL does:
    // `UPDATE ... FROM (VALUES ...)`. One statement can only SET a fixed column
    // list, so rows are grouped by their changed-column SIGNATURE first — and a
    // fleet export produces only a handful of distinct signatures (e.g. "just
    // telemetry", "telemetry + device name"), so ~1,000 round trips collapse to
    // a handful.
    //
    // RETURNING id is what preserves the old semantics: a row whose id vanished
    // between the read above and this write simply does not come back, and is
    // reported as skipped rather than aborting the batch (the reason updateMany,
    // not update, was used before).
    const bySignature = new Map<string, { columns: string[]; rows: ItemUpdate[] }>();
    for (const u of toUpdate) {
      const columns = Object.keys(u.data).sort();
      // A row with no changed columns cannot happen (planImport filters those
      // out), but an empty SET would be invalid SQL — so guard rather than emit.
      if (columns.length === 0) continue;
      const key = columns.join(",");
      const bucket = bySignature.get(key);
      if (bucket) bucket.rows.push(u);
      else bySignature.set(key, { columns, rows: [u] });
    }

    const updatedIds = new Set<string>();
    for (const { columns, rows: sigRows } of bySignature.values()) {
      // Chunk the VALUES list. Postgres caps a statement at 65,535 bind
      // parameters; at the 2,000-row import limit with the widest signature
      // that is ~30,000, which fits — but only by luck, and adding importable
      // columns would erode the margin silently. Chunking keeps each statement
      // far under the ceiling while still being a handful of round trips.
      for (let start = 0; start < sigRows.length; start += UPDATE_CHUNK_ROWS) {
      const rows = sigRows.slice(start, start + UPDATE_CHUNK_ROWS);
      // Identifiers are interpolated, so they must come from the allowlist —
      // never straight from the parsed CSV. planImport only ever produces
      // ItemLoggedFields keys, and this re-checks that at the SQL boundary.
      const unknown = columns.filter((c) => !UPDATABLE_ITEM_COLUMNS.has(c));
      if (unknown.length > 0) {
        throw new ItemError("INVALID", `Refusing to update unknown column(s): ${unknown.join(", ")}`);
      }

      // Target the PHYSICAL column (see FIELD_TO_COLUMN); the VALUES alias keeps
      // using the field name, so the two only have to agree within this
      // statement.
      const setList = Prisma.join(
        columns.map((c) => Prisma.sql`${Prisma.raw(`"${columnFor(c)}"`)} = v.${Prisma.raw(`"${c}"`)}`),
        ", ",
      );
      // Every value is bound, never interpolated. The casts let Postgres type a
      // column that is all-NULL within a chunk; text assigns implicitly to the
      // citext serialNumber column, and lastLogonAt casts to timestamptz (see
      // castFor) because it carries a Date, not a string.
      const tuples = Prisma.join(
        rows.map(
          (r) =>
            Prisma.sql`(${r.itemId}::text, ${Prisma.join(
              columns.map((c) => Prisma.sql`${r.data[c]}${Prisma.raw(`::${castFor(c)}`)}`),
              ", ",
            )})`,
        ),
        ", ",
      );
      const aliasCols = Prisma.raw(["id", ...columns].map((c) => `"${c}"`).join(", "));

      const returned = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        UPDATE "Item" AS t
        SET ${setList},
            -- Raw SQL bypasses Prisma's @updatedAt, so it is set explicitly.
            -- Without this, an imported change would stop bumping updatedAt.
            "updatedAt" = NOW()
        FROM (VALUES ${tuples}) AS v(${aliasCols})
        WHERE t."id" = v."id"
        RETURNING t."id"
      `);
      for (const r of returned) updatedIds.add(r.id);
      }
    }

    const vanished: SkippedRow[] = [];
    const edits: Prisma.ItemEditCreateManyInput[] = [];
    for (const u of toUpdate) {
      if (!updatedIds.has(u.itemId)) {
        vanished.push({ row: u.row, serialNumber: u.serialNumber, reason: "item no longer exists" });
        continue;
      }
      if (u.loggedChanges.length > 0) {
        edits.push({
          itemId: u.itemId,
          editedById: editor.id,
          editedByName: editor.name,
          changes: u.loggedChanges as unknown as Prisma.InputJsonValue,
        });
      }
    }
    const updatedCount = updatedIds.size;
    if (edits.length > 0) await tx.itemEdit.createMany({ data: edits });

    const allSkipped = vanished.length > 0 ? [...skipped, ...vanished] : skipped;
    await tx.importBatch.create({
      data: {
        createdById: editor.id,
        filename,
        addedCount: created.count,
        updatedCount,
        skippedCount: allSkipped.length,
        skipped: allSkipped as unknown as Prisma.InputJsonValue,
      },
    });
    return { added: created.count, updated: updatedCount, skipped: allSkipped };
  }, {
    // A full-fleet MDM refresh is an all-UPDATE import: up to MAX_IMPORT_ROWS (2000)
    // sequential item.updateMany writes (ItemEdits are batched) in one interactive
    // transaction. Prisma's default 5s timeout is far too small; but the ceiling is
    // the hosting function timeout — the import page sets `maxDuration = 60`. maxWait
    // (pool-acquire) and timeout are consumed sequentially, so keep their SUM under
    // 60s (5 + 50 = 55, ~5s headroom) — otherwise a slow pool-acquire plus the txn
    // could reach ~70s and be killed by the platform instead of aborting cleanly here
    // (caught → generic error). Chunking large imports is a deferred follow-up.
    timeout: 50_000,
    maxWait: 5_000,
  });

  if (added < toCreate.length) {
    console.warn(`[commitImport] ${toCreate.length - added} row(s) skipped by the DB serialNumber unique constraint (concurrent import or casing variant).`);
  }

  return { added, updated, skipped: finalSkipped, unchanged: unchanged.length, detected, mismatches: collectMismatches(plan) };
}
