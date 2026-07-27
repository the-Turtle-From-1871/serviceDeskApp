import type { DeployableStatus, Item, ItemStatus, Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { newItemSchema, type NewItemInput } from "./items.schema";
import { parseItemsCsv } from "./csv";
import { planImport, type SkippedRow, type UnresolvedRow, type ExistingItem } from "./import";
import { loadUnitMap, learnUnits, type UnitResolution } from "./units.service";
import { diffItemFields, type ItemLoggedFields } from "./item-diff";
import { learnCategories } from "./categories.service";
import { ItemError } from "./items.errors";

/** The readiness state a brand-new item starts in, as a history row.
 *
 *  WHY THIS EXISTS: the status-over-time chart reconstructs the fleet from
 *  ItemStatusHistory alone. An item with no history row is invisible to it, so
 *  without a baseline at creation the chart would drift permanently below the
 *  real item count — the migration backfilled existing rows once, but every
 *  item created afterwards would be missing. Both creation paths (single
 *  create and CSV import) must write one. */
const baselineHistory = (
  item: { id: string; deployableStatus: DeployableStatus | null; isAccountedFor: boolean },
  actor: { id?: string | null; name: string },
  source: string,
): Prisma.ItemStatusHistoryCreateManyInput => ({
  itemId: item.id,
  deployableStatus: item.deployableStatus,
  isAccountedFor: item.isAccountedFor,
  changedById: actor.id ?? null,
  changedByName: actor.name,
  source,
});

export async function createItem(
  input: NewItemInput,
  createdById: string,
  // Optional so existing callers/tests keep working; the action passes the
  // real admin name so the timeline attributes the baseline correctly.
  createdByName = "System",
): Promise<Item> {
  const data = newItemSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const item = await tx.item.create({ data: { ...data, createdById } });
    await tx.itemStatusHistory.create({
      data: baselineHistory(item, { id: createdById, name: createdByName }, "create"),
    });
    return item;
  });
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

// Server-sortable sort keys. `auditState` (the derived, time-dependent badge)
// is NOT itself an ORDER BY — it maps to the denormalized `lastAuditedAt` column
// (see the orderBy below), which sorts items by audit recency = audit-status
// severity. The rest map straight to their like-named Item columns.
const ITEM_SORT_COLUMNS = new Set([
  "deviceName",
  "make",
  "model",
  "serialNumber",
  "status",
  "auditState",
  "deviceUIC",
  "deviceCategory",
  "deployableStatus",
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
  grouped: boolean;
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
  if (key === "deployableStatus") return { deployableStatus: { sort: dir, nulls: "last" } };
  if (key === "deviceUIC") return { deviceUIC: { sort: dir, nulls: "last" } };
  if (key === "deviceCategory") return { deviceCategory: { sort: dir, nulls: "last" } };
  return { [key]: dir } as Prisma.ItemOrderByWithRelationInput;
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
  /** Group rows by deployableStatus. Defaults ON — pass "none" to flatten. */
  group?: string | null;
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
  // Grouping is the DEFAULT view: rows arrive already clustered by readiness
  // state so the table can print a header per group. It is an ORDER BY, not a
  // separate query per group — grouping must not cost N queries.
  const grouped = opts.group !== "none";

  const orderBy: Prisma.ItemOrderByWithRelationInput[] = [];
  // Grouping outranks the user's sort — otherwise rows from different
  // readiness states interleave and the group headers become nonsense. The UI
  // states this next to the toggle, because it does silently demote the chosen
  // sort to a within-group ordering.
  //
  // EXCEPT when the user is explicitly sorting BY readiness: prepending the
  // group clause there would emit `ORDER BY deployableStatus ASC, deployableStatus DESC`,
  // making the direction control a dead no-op. In that case the user's own key
  // already groups the rows, so it is used directly.
  const sortsByReadiness = sortKeys[0]?.key === "deployableStatus";
  if (grouped && !sortsByReadiness) {
    orderBy.push({ deployableStatus: { sort: "asc", nulls: "last" } });
  }
  for (const k of sortKeys) orderBy.push(orderClauseFor(k));
  // Newest-first is the historical default; keep it when nothing else orders.
  if (sortKeys.length === 0) orderBy.push({ createdAt: "desc" });
  // Secondary key by id so rows with equal sort values keep a stable order across
  // pages (otherwise the same row can appear on two pages or none).
  orderBy.push({ id: "asc" });

  const total = await prisma.item.count({ where });
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Math.floor(opts.page ?? 1)), totalPages);
  const items = await prisma.item.findMany({ where, orderBy, skip: (page - 1) * pageSize, take: pageSize });

  return {
    items,
    total,
    page,
    pageSize,
    sort: sortKeys[0]?.key ?? null,
    dir: sortKeys[0]?.dir ?? "desc",
    sortKeys,
    grouped,
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

/** Hard cap on one bulk action. The UI selects at most a page at a time, but
 *  the action is reachable by POST, so the server bounds it too. */
export const MAX_BULK_ITEMS = 500;

export type BulkReadinessInput = {
  deployableStatus?: DeployableStatus | null;
  isAccountedFor?: boolean;
};

/**
 * Set readiness fields on many items at once, recording the new state of each
 * changed item in ItemStatusHistory.
 *
 * Correctness properties that must not be lost:
 *  - ONE transaction. The Item write and its history rows commit together, so
 *    the timeline can never disagree with the current state.
 *  - NO query in a loop. Three statements total (read, updateMany, createMany)
 *    regardless of how many items are selected.
 *  - Only genuinely CHANGED items are touched. Re-applying the status an item
 *    already has writes nothing, so the chart doesn't grow a step where
 *    nothing actually happened.
 *
 * Enforces NO permissions — the calling Server Action owns the admin guard.
 */
export async function bulkUpdateReadiness(
  itemIds: string[],
  data: BulkReadinessInput,
  actor: ItemEditor,
): Promise<{ updated: number }> {
  const ids = [...new Set(itemIds.filter((id) => id.trim() !== ""))];
  if (ids.length === 0) return { updated: 0 };
  if (ids.length > MAX_BULK_ITEMS) throw new ItemError("TOO_MANY");
  if (data.deployableStatus === undefined && data.isAccountedFor === undefined) {
    return { updated: 0 };
  }

  return prisma.$transaction(async (tx) => {
    const current = await tx.item.findMany({
      where: { id: { in: ids } },
      select: { id: true, deployableStatus: true, isAccountedFor: true },
    });

    const changed = current.filter(
      (it) =>
        (data.deployableStatus !== undefined && data.deployableStatus !== it.deployableStatus) ||
        (data.isAccountedFor !== undefined && data.isAccountedFor !== it.isAccountedFor),
    );
    if (changed.length === 0) return { updated: 0 };

    const changedIds = changed.map((c) => c.id);
    await tx.item.updateMany({
      where: { id: { in: changedIds } },
      data: {
        ...(data.deployableStatus !== undefined ? { deployableStatus: data.deployableStatus } : {}),
        ...(data.isAccountedFor !== undefined ? { isAccountedFor: data.isAccountedFor } : {}),
      },
    });

    // Snapshot the resulting state — the fields the caller did NOT set keep
    // each item's existing value, so every history row is a complete picture
    // of that item rather than a partial delta.
    await tx.itemStatusHistory.createMany({
      data: changed.map((it) => ({
        itemId: it.id,
        deployableStatus:
          data.deployableStatus !== undefined ? data.deployableStatus : it.deployableStatus,
        isAccountedFor:
          data.isAccountedFor !== undefined ? data.isAccountedFor : it.isAccountedFor,
        changedById: actor.id,
        changedByName: actor.name,
        source: "bulk",
      })),
    });

    return { updated: changed.length };
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
        ...toUpdate.map((u) => u.data.deviceCategory),
      ],
      tx,
    );

    const created = await tx.item.createMany({
      // The DB unique(serialNumber, citext) is the race-safe backstop: skip rather
      // than throw on a serial a concurrent import inserted after loadExistingBySerial.
      data: toCreate.map((d) => ({ ...d, createdById: editor.id })),
      skipDuplicates: true,
    });

    // Baseline history for the rows this import actually created (see
    // baselineHistory). createMany returns a count, not ids, so the new rows
    // are re-read by serial — and filtered to those with NO history yet, which
    // both excludes the serials skipDuplicates bounced and stays correct if a
    // concurrent import created one first. Two statements, not one per row.
    if (created.count > 0) {
      const newlyCreated = await tx.item.findMany({
        where: {
          serialNumber: { in: toCreate.map((d) => d.serialNumber) },
          statusHistory: { none: {} },
        },
        select: { id: true, deployableStatus: true, isAccountedFor: true },
      });
      if (newlyCreated.length > 0) {
        await tx.itemStatusHistory.createMany({
          data: newlyCreated.map((i) => baselineHistory(i, editor, "import")),
        });
      }
    }

    // item.update must be per-row (distinct values, no batch form in Prisma), but
    // updateMany (not update) so a serial deleted between the read above and this
    // write is a no-op (count 0) instead of a P2025 that aborts the whole batch —
    // the vanished row is reported as skipped, not silently dropped. The ItemEdit
    // rows are uniform-shape, so they're collected and written in ONE createMany
    // after the loop instead of one insert per row. Bounded by the 2000-row cap.
    let updatedCount = 0;
    const vanished: SkippedRow[] = [];
    const edits: Prisma.ItemEditCreateManyInput[] = [];
    for (const u of toUpdate) {
      const res = await tx.item.updateMany({ where: { id: u.itemId }, data: u.data });
      if (res.count === 0) {
        vanished.push({ row: u.row, serialNumber: u.serialNumber, reason: "item no longer exists" });
        continue;
      }
      updatedCount++;
      if (u.loggedChanges.length > 0) {
        edits.push({
          itemId: u.itemId,
          editedById: editor.id,
          editedByName: editor.name,
          changes: u.loggedChanges as unknown as Prisma.InputJsonValue,
        });
      }
    }
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
