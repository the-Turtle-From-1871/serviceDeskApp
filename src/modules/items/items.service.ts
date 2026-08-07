// Prisma is a VALUE import here, not type-only: the batched import UPDATE uses
// Prisma.sql / Prisma.join / Prisma.raw to build a parameterized statement.
import { Prisma } from "@prisma/client";
import type { Item, ItemStatus } from "@prisma/client";
import prisma from "@/lib/prisma";
// normalizeCategoryName comes from the PURE schema module, not categories.service
// (which is `server-only`): every write path must apply the same canonical form
// or an item's stored string and its vocabulary row drift apart.
import { newItemSchema, normalizeCategoryName, type NewItemInput } from "./items.schema";
import { parseItemsCsv } from "./csv";
import { planImport, type SkippedRow, type UnresolvedRow, type ExistingItem, type ItemUpdate } from "./import";
import { loadUnitMap, learnUnits, type UnitResolution } from "./units.service";
import { diffItemFields, type ItemLoggedFields } from "./item-diff";
import { learnCategories } from "./categories.service";
import { READINESS_JOINS, READINESS_RANK } from "./readiness.sql";
import { CUSTODY_FROM, OPEN_CUSTODY_PREDICATE } from "@/modules/transfers/custody.sql";
import { ItemError } from "./items.errors";
import { recipientTokens } from "./recipient-search";

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

/** Resolve an item id from a serial. Used ONLY on the create path's P2002
 *  branch, to turn "that serial is taken" into a link to the item that took it.
 *  `serialNumber` is @unique @db.Citext, so this matches regardless of casing
 *  and can return at most one row. Selects the id alone — the caller needs a
 *  link, not a device. */
export function getItemBySerial(serialNumber: string) {
  return prisma.item.findUnique({
    where: { serialNumber },
    select: { id: true },
  });
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

// The sort vocabulary lives in the leaf module `./sort-keys` so the client
// table can share ONE definition without importing this server-only file (and
// with it a Prisma client). Re-exported for existing importers.
import {
  SORT_COLUMN,
  ITEM_SORT_COLUMNS,
  DERIVED_SORT_KEYS,
  READINESS_SORT_KEY,
  AUDIT_SORT_KEY,
} from "./sort-keys";
export { SORT_COLUMN, ITEM_SORT_COLUMNS };
import { auditCutoff } from "@/modules/audit/audit.status";
import { auditRankSql } from "@/modules/audit/audit.sql";

/** Resolve a sort key to its physical column, or refuse.
 *
 *  `Object.hasOwn`, not a truthiness check on `SORT_COLUMN[key]`: a plain object
 *  literal inherits `toString`/`constructor`/`valueOf`, so a key of "toString"
 *  would return an inherited FUNCTION, sail past `if (!column)`, and be spliced
 *  into the ORDER BY. `parseSortKeys` gates on ITEM_SORT_COLUMNS today so
 *  nothing reaches here unvetted — but that Set is only compile-time readonly
 *  (contents are internal slots, so neither the type nor Object.freeze stops
 *  `.add`). THIS check is the actual runtime guard on the SQL-identifier
 *  boundary, and the only one that holds for a caller that builds SortKeys some
 *  other way. */
function columnForKey(key: string): string {
  if (!Object.hasOwn(SORT_COLUMN, key)) {
    throw new ItemError("INVALID", `Refusing to sort by unknown column: ${key}`);
  }
  return SORT_COLUMN[key];
}

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

/**
 * Map one sort key to a Prisma orderBy clause.
 *
 * NO KEY PINS ITS BLANKS. Every clause is a bare `{ column: dir }`, never
 * `{ sort, nulls }`, so empties sort as a VALUE: they gather at one end and
 * swap ends when the direction is reversed, and reversing a sort reverses the
 * whole list. Pinning even one column would leave part of the list unmoved on
 * reverse, which reads as a broken sort — and it has to hold on BOTH paths, or
 * a sort would mean different things depending on whether a derived key happens
 * to be among them (see derivedOrderedItemIds, which says the same).
 *
 * Only NON-derived keys reach here: a sort naming `readiness` or `auditState`
 * takes the raw path entirely, and columnForKey refuses them.
 */
function orderClauseFor({ key, dir }: SortKey): Prisma.ItemOrderByWithRelationInput {
  // Resolved through the same helper the raw path uses, so the two can never
  // disagree about what a key means, and an unmapped key raises a typed
  // ItemError instead of producing `{ undefined: dir }` and a generic Prisma
  // failure.
  return { [columnForKey(key)]: dir } as Prisma.ItemOrderByWithRelationInput;
}

/*
 * NOTE ON EMPTIES: nothing here pins NULLs to a fixed end.
 *
 * Blanks sort as a VALUE, so they gather at one end and swap ends when the
 * direction is reversed — Postgres's default (NULLS LAST ascending, NULLS FIRST
 * descending), which is what a bare Prisma `{ column: dir }` emits on both
 * paths. Reversing a sort therefore reverses the whole list, blanks included.
 *
 * Some of these columns previously carried `nulls: "last"`, pinning empties to
 * the bottom in both directions. That was deliberately removed: it made
 * reversing a sort leave part of the list unmoved, which reads as the sort
 * being broken. Do not reintroduce it for one column without doing so for every
 * nullable sortable column — the inconsistency is worse than either rule.
 */

/** The recipient half of the search filter, as SQL.
 *
 *  The joins and the custody guards come from custody.sql.ts, the ONE
 *  definition of live custody — the same fragments READINESS_CASE's DEPLOYED
 *  branch and holdersForItems embed — so "held by" means one thing across the
 *  filter, the Readiness badge and the Holder column, by construction rather
 *  than by three copies happening to agree. Only what is genuinely this query's
 *  stays local: the correlation to the outer item row and the name match. An
 *  EXISTS rather than a join so an item on two receipts still counts once and
 *  cannot duplicate a row.
 *
 *  Tokens are AND'd (see recipient-search.ts) and every pattern is a BOUND
 *  parameter (CLAUDE.md §2). With no tokens the branch renders as FALSE; the
 *  caller's `${pattern}::text IS NULL OR …` guard has already short-circuited
 *  the whole group in that case, so this is belt-and-braces rather than a path
 *  anything reaches. */
function recipientMatchSql(tokens: string[]): Prisma.Sql {
  if (tokens.length === 0) return Prisma.sql`FALSE`;
  const clauses = tokens.map((t) => Prisma.sql`t."receiverName" ILIKE ${`%${t}%`}`);
  return Prisma.sql`EXISTS (
      SELECT 1
      ${CUSTODY_FROM}
      WHERE ti."itemId" = i."id"
        AND ${OPEN_CUSTODY_PREDICATE}
        AND ${Prisma.join(clauses, " AND ")}
    )`;
}

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
 *  does for the dashboard.
 *
 *  The recipient branch is an EXISTS over open hand receipts (recipientMatchSql)
 *  — the filter now spans a relation, so the Prisma twin above is a nested
 *  `some`, not another column `contains`. Both must change together. */
function itemFilterSql(search: string | null, uic: string | null): Prisma.Sql {
  const pattern = search ? `%${search}%` : null;
  return Prisma.sql`
    (${pattern}::text IS NULL
      OR i."deviceName" ILIKE ${pattern}::text
      OR i."make" ILIKE ${pattern}::text
      OR i."model" ILIKE ${pattern}::text
      OR i."serialNumber"::text ILIKE ${pattern}::text
      OR ${recipientMatchSql(search ? recipientTokens(search) : [])})
    AND (${uic}::text IS NULL OR i."deviceUIC" = ${uic}::text)`;
}

/**
 * ONE page of item ids, ordered by a sort that involves a DERIVED key.
 *
 * Neither readiness nor the audit badge has a column for Prisma to `orderBy` —
 * readiness is computed from four signals across three tables, and the audit
 * badge from `lastAuditedAt` against the audit period — but Postgres can derive
 * both inline from the same CASEs the badges and the dashboard read, ranked by
 * READINESS_RANK / auditRankSql. Selecting ids ONLY keeps this cheap and lets
 * getItemsByIds hydrate the page: two bounded queries for the whole list, never
 * a derivation per row.
 *
 * LIMIT/OFFSET carry the page-size cap over from the Prisma path, and the `id`
 * tie-break is repeated for the reason it exists there — a rank has a handful of
 * distinct values across 1,200+ rows, so without a total order a row could
 * appear on two pages or on none.
 *
 * `now` is threaded in rather than read here so the audit cutoff is fixed for
 * the whole query and a test can pin it.
 */
async function derivedOrderedItemIds(opts: {
  search: string | null;
  uic: string | null;
  sortKeys: SortKey[];
  skip: number;
  take: number;
  now: Date;
}): Promise<string[]> {
  const terms: Prisma.Sql[] = [];
  for (const { key, dir } of opts.sortKeys) {
    const direction = Prisma.raw(dir === "asc" ? "ASC" : "DESC");
    if (key === READINESS_SORT_KEY) {
      terms.push(Prisma.sql`${READINESS_RANK} ${direction}`);
      continue;
    }
    if (key === AUDIT_SORT_KEY) {
      // The BADGE, not the timestamp behind it. Ordering by `lastAuditedAt`
      // here is what made a secondary key a no-op: stamps are near-unique, so
      // there were no ties to break. See auditRankSql.
      terms.push(Prisma.sql`${auditRankSql(auditCutoff(opts.now))} ${direction}`);
      continue;
    }
    // parseSortKeys already dropped anything unknown; columnForKey re-checks at
    // the SQL boundary so a future caller that builds SortKeys some other way
    // cannot splice an identifier of its own choosing into the ORDER BY.
    const ref = Prisma.raw(`i."${columnForKey(key)}"`);
    // Bare ordering, no NULLS override — blanks swap ends with the direction,
    // exactly as the Prisma path's `{ column: dir }` does. Keeping these two in
    // step is what stops a sort behaving differently depending on whether a
    // derived key happens to be among them.
    terms.push(Prisma.sql`${ref} ${direction}`);
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
    // `search` is trimmed and non-empty here, so this yields at least one token.
    const tokens = recipientTokens(search);
    filters.push({
      OR: [
        { deviceName: { contains: search, mode: "insensitive" } },
        { make: { contains: search, mode: "insensitive" } },
        { model: { contains: search, mode: "insensitive" } },
        { serialNumber: { contains: search, mode: "insensitive" } },
        // The recipient named on the item's CURRENT custody — an open receipt
        // with this row unreturned. Same rule as READINESS_CASE's DEPLOYED
        // branch, deliberately NOT getHoldingTransfer's stricter
        // latest-receipt-only rule: this must agree with the Readiness badge
        // and the Holder column rendered on the same row.
        //
        // Tokens are AND'd, so "doe jane" finds "Jane Doe" — see
        // recipient-search.ts. Whatever changes here changes in itemFilterSql
        // too, or items.readiness-sort.parity.test.ts fails.
        {
          transferItems: {
            some: {
              returnedAt: null,
              line: {
                transfer: {
                  status: "OPEN",
                  AND: tokens.map((t) => ({
                    receiverName: { contains: t, mode: "insensitive" as const },
                  })),
                },
              },
            },
          },
        },
      ],
    });
  }
  if (uic) filters.push({ deviceUIC: uic });
  const where: Prisma.ItemWhereInput | undefined =
    filters.length === 0 ? undefined : filters.length === 1 ? filters[0] : { AND: filters };

  const sortKeys = parseSortKeys(opts.sort, opts.dir);

  // DERIVED sorts go through a SEPARATE, raw-SQL path — not because they are
  // special, but because neither has a column for a Prisma `orderBy` to name:
  // readiness is computed from four signals across three tables (readiness.ts),
  // and the audit badge is a three-value CASE over `lastAuditedAt` against the
  // audit period (audit.sql.ts). The two alternatives were worse: a stored copy
  // on Item is the `deployableStatus` column that was deliberately dropped for
  // drifting, and sorting a fetched page in JavaScript would order 50 rows while
  // claiming to order 1,200. Postgres CAN order both — the same CASEs the badges
  // and the dashboard read — so a sort involving either selects its ids in SQL
  // and hydrates them, and every other sort stays on the untouched Prisma path.
  const sortsByDerived = sortKeys.some((k) => DERIVED_SORT_KEYS.has(k.key));

  // The chosen sort is the whole ORDER BY.
  const orderBy: Prisma.ItemOrderByWithRelationInput[] = [];
  if (!sortsByDerived) {
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
  const items = sortsByDerived
    ? await getItemsByIds(
        await derivedOrderedItemIds({
          search: search ?? null,
          uic,
          sortKeys,
          skip,
          take: pageSize,
          now: new Date(),
        }),
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

export type ItemFieldSuggestions = { make: string[]; model: string[]; deviceUIC: string[] };

/**
 * The free-text catalogue vocabularies, for the suggestion comboboxes.
 *
 * Make, model and UIC have no managed list (unlike Category and Unit), so the
 * vocabulary IS what the fleet already holds. Category and Home unit are NOT
 * sourced here on purpose: they come from listCategoryNames()/listUnits(), so
 * the picker agrees with the screens that curate them and cannot resurrect a
 * name an admin deleted.
 *
 * ONE query, three UNION ALL arms — not a query per field, and not a query per
 * row. Ordered by frequency so the makes actually in use head an 8-row list.
 * The per-field cap is a guard against a future dirty import turning this into
 * an unbounded payload, not a reflection of today's counts (16 makes, 53
 * models, ~44 UICs).
 *
 * COUNT(*)::int, not COUNT(*): Postgres counts are bigint, which Prisma hands
 * back as BigInt and JSON.stringify refuses to serialize.
 */
const SUGGESTION_CAP = 200;

export async function listItemFieldSuggestions(): Promise<ItemFieldSuggestions> {
  const rows = await prisma.$queryRaw<{ field: string; value: string; n: number }[]>(Prisma.sql`
    (SELECT 'make' AS field, "make" AS value, COUNT(*)::int AS n
       FROM "Item" WHERE btrim(COALESCE("make", '')) <> ''
       GROUP BY "make" ORDER BY n DESC, value ASC LIMIT ${SUGGESTION_CAP})
    UNION ALL
    (SELECT 'model' AS field, "model" AS value, COUNT(*)::int AS n
       FROM "Item" WHERE btrim(COALESCE("model", '')) <> ''
       GROUP BY "model" ORDER BY n DESC, value ASC LIMIT ${SUGGESTION_CAP})
    UNION ALL
    (SELECT 'deviceUIC' AS field, "deviceUIC" AS value, COUNT(*)::int AS n
       FROM "Item" WHERE btrim(COALESCE("deviceUIC", '')) <> ''
       GROUP BY "deviceUIC" ORDER BY n DESC, value ASC LIMIT ${SUGGESTION_CAP})
  `);

  // Sorted in JS rather than trusting the UNION ALL to preserve each arm's
  // ORDER BY — Postgres does not guarantee the output order of a set operation,
  // only the order WITHIN each parenthesized arm's LIMIT.
  const bucket = (field: string) =>
    rows
      .filter((r) => r.field === field)
      .sort((a, b) => b.n - a.n || a.value.localeCompare(b.value))
      .map((r) => r.value);

  return { make: bucket("make"), model: bucket("model"), deviceUIC: bucket("deviceUIC") };
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
  "storageLocation",
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
 * "Ready to deploy" until a deliberate act contradicts it — an open hand
 * receipt, a service flag, retirement, or an explicit clear. MDM telemetry does
 * NOT override it: a device on our own shelf produces logons routinely, so the
 * rule that let a newer logon expire the stamp was removed. It stays a
 * timestamp rather than a boolean so the marking can be COMPARED to other dated
 * signals, and so "when did we last have hands on this" stays answerable.
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

/**
 * Clear the hand-set readiness signal — the exact inverse of markItemsReady.
 *
 * This is what "Set readiness → Untriaged" does. It does NOT store an
 * "UNTRIAGED" value anywhere: readiness stays derived (readiness.ts), and
 * removing the only hand-set signal is what makes a device fall back through
 * the precedence chain to Untriaged (assuming no receipt / service flag / MDM
 * logon is speaking for it — if one is, it keeps reading Deployed or In repair,
 * which is correct: those are facts, not opinions).
 *
 * NO `status: "ACTIVE"` filter — and that asymmetry with markItemsReady is
 * deliberate, not an oversight. markItemsReady excludes retired kit because
 * ASSERTING "this is back on my shelf" about a device that has left the fleet
 * is meaningless. Clearing RETRACTS an assertion, and a retired row can still be
 * carrying a stale stamp from before it was retired; reactivate it later and it
 * would read "Ready to deploy" off a marking nobody ever re-checked. A
 * retraction must be able to reach every row the admin selected.
 *
 * Only rows that actually hold a stamp are written, so `updated` is a truthful
 * "how many were cleared" rather than "how many were selected".
 *
 * Enforces NO permissions — the calling Server Action owns the admin guard.
 */
export async function clearItemsReady(itemIds: string[]): Promise<{ updated: number }> {
  const ids = [...new Set(itemIds.filter((id) => id.trim() !== ""))];
  if (ids.length === 0) return { updated: 0 };
  if (ids.length > MAX_BULK_ITEMS) throw new ItemError("TOO_MANY");

  const res = await prisma.item.updateMany({
    where: { id: { in: ids }, markedReadyAt: { not: null } },
    data: { markedReadyAt: null },
  });
  return { updated: res.count };
}

/**
 * Bulk lifecycle change — the many-row sibling of setItemStatus.
 *
 * `status` is the LIFECYCLE column (ACTIVE / RETIRED), not a readiness state.
 * It happens to be the top of the readiness precedence chain (a RETIRED item
 * reads RETIRED regardless of every other signal), which is why the readiness
 * selector can offer "Retired" and "Active" without storing a readiness value.
 *
 * Skips rows already at the target status so `updated` counts real changes.
 * Writes no ItemEdit: status is not one of ItemLoggedFields, and the
 * single-item path (setItemStatus) records none either — keeping them
 * consistent matters more than adding history on one surface only.
 *
 * Enforces NO permissions — the calling Server Action owns the admin guard.
 */
export async function setItemsStatus(
  itemIds: string[],
  status: ItemStatus,
): Promise<{ updated: number }> {
  const ids = [...new Set(itemIds.filter((id) => id.trim() !== ""))];
  if (ids.length === 0) return { updated: 0 };
  if (ids.length > MAX_BULK_ITEMS) throw new ItemError("TOO_MANY");

  const res = await prisma.item.updateMany({
    where: { id: { in: ids }, status: { not: status } },
    data: { status },
  });
  return { updated: res.count };
}

/**
 * Assign one category to many items, logging an ItemEdit per item that changed.
 *
 * THREE queries total, regardless of selection size — never one per item:
 *   1. ONE findMany for the before-values (only `id` + `deviceCategory`; never
 *      the whole row, which would drag notes and holder PII through memory);
 *   2. ONE updateMany over just the ids whose value actually differs;
 *   3. ONE createMany of the history rows.
 * Plus learnCategories' single skipDuplicates insert. All in ONE transaction, so
 * the fleet and its history can never be left disagreeing. Looping
 * updateItemFields would have been N transactions and 3N queries.
 *
 * The change payload is built by the SAME diffItemFields the single-item edit
 * path uses, so a bulk row and a hand-edited row are indistinguishable to
 * anything reading ItemEdit.changes. Items already holding the value get no
 * history row at all.
 *
 * NO status filter: re-categorizing retired kit is legitimate data cleanup, and
 * unlike readiness the category says nothing about whether the device is usable.
 *
 * Enforces NO permissions and trusts `editor` — the calling Server Action owns
 * the admin guard.
 */
export async function setItemsCategory(
  itemIds: string[],
  rawCategory: string,
  editor: ItemEditor,
): Promise<{ updated: number; unchanged: number }> {
  const ids = [...new Set(itemIds.filter((id) => id.trim() !== ""))];
  if (ids.length === 0) return { updated: 0, unchanged: 0 };
  if (ids.length > MAX_BULK_ITEMS) throw new ItemError("TOO_MANY");

  const deviceCategory = normalizeCategoryName(rawCategory);
  if (!deviceCategory) throw new ItemError("INVALID", "Choose a category.");

  return prisma.$transaction(async (tx) => {
    const before = await tx.item.findMany({
      where: { id: { in: ids } },
      select: { id: true, deviceCategory: true },
    });

    // Pure, in-memory diff — no query in this map.
    const edits = before
      .map((row) => ({
        id: row.id,
        changes: diffItemFields({ deviceCategory: row.deviceCategory }, { deviceCategory }),
      }))
      .filter((e) => e.changes.length > 0);

    if (edits.length === 0) return { updated: 0, unchanged: before.length };

    const res = await tx.item.updateMany({
      where: { id: { in: edits.map((e) => e.id) } },
      data: { deviceCategory },
    });
    await tx.itemEdit.createMany({
      data: edits.map((e) => ({
        itemId: e.id,
        editedById: editor.id,
        editedByName: editor.name,
        changes: e.changes as unknown as Prisma.InputJsonValue,
      })),
    });

    // Closes the race where the picked category is deleted between the page
    // render and this write: deletion is only refused while a category is IN
    // USE, and these items were not using it yet. Re-registering keeps the
    // value visible in the picker instead of stranding the devices on a string
    // no admin can select again. ONE skipDuplicates insert.
    await learnCategories([deviceCategory], tx);

    return { updated: res.count, unchanged: before.length - edits.length };
  });
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

/**
 * Permanently delete an item. There is no undo; Retire is the reversible one.
 *
 * A single delete does the whole job. ServiceQueueItem, ItemEdit and ItemAudit
 * are ON DELETE CASCADE — item-scoped history that has nothing to describe once
 * the item is gone — and TransferItem is ON DELETE SET NULL, so hand receipts
 * keep every line they were signed with.
 *
 * No ItemEdit row is written for the deletion: it would belong to the item
 * being deleted, and would cascade away in the same statement.
 *
 * Enforces NO permissions — the calling Server Action owns the admin guard.
 */
export async function deleteItem(id: string): Promise<void> {
  await prisma.item.delete({ where: { id } });
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
      id: true, status: true, serialNumber: true, make: true, model: true, deviceName: true, homeUnit: true,
      deviceUIC: true, deviceCategory: true, storageLocation: true, currentUserEmail: true, lastLogonUserPrincipalName: true, lastLogonDate: true,
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
): Promise<{ added: number; updated: number; skipped: SkippedRow[]; unchanged: number; detected: number; mismatches: { serialNumber: string }[]; unresolved: UnresolvedRow[]; error?: string }> {
  const { rows, error } = parseItemsCsv(text);
  if (error) return { added: 0, updated: 0, skipped: [], unchanged: 0, detected: 0, mismatches: [], unresolved: [], error };

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
    // the hosting function timeout — BOTH callers of commitImport set
    // `maxDuration = 60` (the interactive /admin/items/import page, and the
    // automated POST /api/items/import route — see the comment there for the
    // full breakdown). maxWait (pool-acquire) and timeout are consumed
    // sequentially, so their SUM is this transaction's real budget: 5 + 40 = 45s
    // out of that 60s ceiling.
    //
    // 40s, not 50s: the 60s function budget also has to cover work that happens
    // OUTSIDE this transaction, in the same invocation — reading the uploaded
    // file, resolving the import actor, and (right above, before this
    // transaction opens) the loadExistingBySerial + loadUnitMap queries, plus a
    // cold start's Prisma engine init and first pool connect. At 50s that
    // pre-transaction work had only ~5s of headroom under the 60s ceiling, which
    // a slow cold start or a slow pool acquire could plausibly exceed — and if
    // the platform kills the function instead of the transaction aborting on
    // its own, the caller gets a raw platform 504 instead of the clean
    // `500 {"error":"Import failed"}` DEPLOY.md and the MDM hand-off doc both
    // promise. 40s leaves ~15s for that pre-transaction work and unwind, which
    // is ample: the measured 2000-row all-update run was ~0.8s locally, and the
    // work is round-trip bounded (~15-20 queries), not row bounded — see
    // DEPLOY.md §7a. Chunking large imports remains a deferred follow-up if a
    // slower production database ever needs more room than this buys back.
    timeout: 40_000,
    maxWait: 5_000,
  });

  if (added < toCreate.length) {
    console.warn(`[commitImport] ${toCreate.length - added} row(s) skipped by the DB serialNumber unique constraint (concurrent import or casing variant).`);
  }

  // `unresolved` is surfaced (not just counted) because the automated import has
  // no human at the resolution step — the caller reports it so an admin can teach
  // the abbreviation later. The browser flow ignores this field; it gets the same
  // list from analyzeImport before committing.
  return { added, updated, skipped: finalSkipped, unchanged: unchanged.length, detected, mismatches: collectMismatches(plan), unresolved: plan.unresolved };
}
