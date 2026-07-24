import type { Item, ItemStatus, Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { newItemSchema, type NewItemInput } from "./items.schema";
import { parseItemsCsv } from "./csv";
import { planImport, type SkippedRow, type UnresolvedRow, type ExistingItem } from "./import";
import { loadUnitMap, learnUnits, type UnitResolution } from "./units.service";
import { diffItemFields, type ItemLoggedFields } from "./item-diff";
import { ItemError } from "./items.errors";

export async function createItem(input: NewItemInput, createdById: string): Promise<Item> {
  const data = newItemSchema.parse(input);
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

// Server-sortable sort keys. `auditState` (the derived, time-dependent badge)
// is NOT itself an ORDER BY — it maps to the denormalized `lastAuditedAt` column
// (see the orderBy below), which sorts items by audit recency = audit-status
// severity. The rest map straight to their like-named Item columns.
const ITEM_SORT_COLUMNS = new Set(["deviceName", "make", "model", "serialNumber", "status", "auditState"]);

export const ITEMS_PAGE_SIZE = 50;

export type ItemsPage = {
  items: Item[];
  total: number;
  page: number;
  pageSize: number;
  sort: string | null;
  dir: "asc" | "desc";
};

// Paginated, sorted item list. Bounds the fetch and the RSC payload (the table was
// previously unbounded — every row shipped to the client on each load). Sort and
// paging are server-side so they act over the whole result set, not just one page.
export async function listItems(opts: {
  search?: string;
  sort?: string | null;
  dir?: string | null;
  page?: number;
  pageSize?: number;
} = {}): Promise<ItemsPage> {
  const pageSize = opts.pageSize && opts.pageSize > 0 ? Math.floor(opts.pageSize) : ITEMS_PAGE_SIZE;
  const search = opts.search?.trim();
  const where: Prisma.ItemWhereInput | undefined = search
    ? {
        OR: [
          { deviceName: { contains: search, mode: "insensitive" } },
          { make: { contains: search, mode: "insensitive" } },
          { model: { contains: search, mode: "insensitive" } },
          { serialNumber: { contains: search, mode: "insensitive" } },
        ],
      }
    : undefined;

  const sort = opts.sort && ITEM_SORT_COLUMNS.has(opts.sort) ? opts.sort : null;
  const dir: "asc" | "desc" = opts.dir === "asc" ? "asc" : "desc";
  // Secondary key by id so rows with equal sort values keep a stable order across
  // pages (otherwise the same row can appear on two pages or none). The
  // audit-status sort rides the denormalized `lastAuditedAt` column; never-audited
  // rows (null) always trail the dated ones, in both directions.
  const primaryOrder: Prisma.ItemOrderByWithRelationInput = !sort
    ? { createdAt: "desc" }
    : sort === "auditState"
    ? { lastAuditedAt: { sort: dir, nulls: "last" } }
    : ({ [sort]: dir } as Prisma.ItemOrderByWithRelationInput);
  const orderBy: Prisma.ItemOrderByWithRelationInput[] = [primaryOrder, { id: "asc" }];

  const total = await prisma.item.count({ where });
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Math.floor(opts.page ?? 1)), totalPages);
  const items = await prisma.item.findMany({ where, orderBy, skip: (page - 1) * pageSize, take: pageSize });

  return { items, total, page, pageSize, sort, dir };
}

export type ItemEditor = { id: string; name: string };

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
      currentUserEmail: true, lastLogonUserPrincipalName: true, lastLogonDate: true,
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
    const created = await tx.item.createMany({
      // The DB unique(serialNumber, citext) is the race-safe backstop: skip rather
      // than throw on a serial a concurrent import inserted after loadExistingBySerial.
      data: toCreate.map((d) => ({ ...d, createdById: editor.id })),
      skipDuplicates: true,
    });

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
    // sequential item.update + itemEdit.create pairs in one interactive transaction.
    // Prisma's default interactive-transaction timeout is 5s, which a few hundred
    // round-trips to hosted Postgres can blow — aborting and rolling back the whole
    // import. Size the budget to the row cap instead. maxWait covers pool-acquire.
    timeout: 120_000,
    maxWait: 15_000,
  });

  if (added < toCreate.length) {
    console.warn(`[commitImport] ${toCreate.length - added} row(s) skipped by the DB serialNumber unique constraint (concurrent import or casing variant).`);
  }

  return { added, updated, skipped: finalSkipped, unchanged: unchanged.length, detected, mismatches: collectMismatches(plan) };
}
