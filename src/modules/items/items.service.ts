import type { Item, ItemStatus, Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { newItemSchema, type NewItemInput } from "./items.schema";
import { parseItemsCsv } from "./csv";
import { planImport, type SkippedRow, type UnresolvedRow } from "./import";
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

// Server-sortable columns only. `auditState` (shown in the table) is derived from
// ItemAudit rows, not an Item column, so it cannot be an ORDER BY — the UI omits
// it from the sort options.
const ITEM_SORT_COLUMNS = new Set(["deviceName", "make", "model", "serialNumber", "status"]);

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
  // pages (otherwise the same row can appear on two pages or none).
  const orderBy: Prisma.ItemOrderByWithRelationInput[] = sort
    ? [{ [sort]: dir } as Prisma.ItemOrderByWithRelationInput, { id: "asc" }]
    : [{ createdAt: "desc" }, { id: "asc" }];

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

export async function analyzeImport(text: string): Promise<{
  counts: { toImport: number; skipped: number; autoDetected: number };
  skipped: SkippedRow[];
  unresolved: UnresolvedRow[];
  error?: string;
}> {
  const { rows, error } = parseItemsCsv(text);
  if (error) return { counts: { toImport: 0, skipped: 0, autoDetected: 0 }, skipped: [], unresolved: [], error };

  const existing = new Set(
    // Lowercased to match the DB's case-insensitive (citext) unique on serialNumber,
    // so planImport dedups "ABC123" and "abc123" as the same device.
    (await prisma.item.findMany({ select: { serialNumber: true } })).map((i) => i.serialNumber.toLowerCase())
  );
  const units = await loadUnitMap();
  const { toCreate, skipped, unresolved, detected } = planImport(rows, existing, units);

  return {
    counts: { toImport: toCreate.length, skipped: skipped.length, autoDetected: detected },
    skipped,
    unresolved,
  };
}

export async function commitImport(
  text: string,
  filename: string,
  resolutions: UnitResolution[],
  createdById: string
): Promise<{ added: number; skipped: SkippedRow[]; detected: number; error?: string }> {
  const { rows, error } = parseItemsCsv(text);
  if (error) return { added: 0, skipped: [], detected: 0, error };

  // Persist what the admin taught us BEFORE planning, so detection re-runs with
  // the enriched map and applies each new unit to every row that shares its code.
  await learnUnits(resolutions);

  const existing = new Set(
    // Lowercased to match the DB's case-insensitive (citext) unique on serialNumber,
    // so planImport dedups "ABC123" and "abc123" as the same device.
    (await prisma.item.findMany({ select: { serialNumber: true } })).map((i) => i.serialNumber.toLowerCase())
  );
  const units = await loadUnitMap();
  const { toCreate, skipped, detected } = planImport(rows, existing, units);

  const added = await prisma.$transaction(async (tx) => {
    const created = await tx.item.createMany({
      data: toCreate.map((d) => ({ ...d, createdById })),
      // The DB unique(serialNumber, citext) is the real dedup: skip — rather than
      // throw on — any serial a concurrent import inserted between our read of
      // `existing` above and this write. Fixes the read-then-write race.
      skipDuplicates: true,
    });
    await tx.importBatch.create({
      data: {
        createdById,
        filename,
        addedCount: created.count,
        skippedCount: skipped.length,
        skipped: skipped as unknown as Prisma.InputJsonValue,
      },
    });
    return created.count;
  });

  // added < toCreate.length means the DB skipped rows the in-app planner didn't
  // catch (a concurrent import or a casing variant) — rare; surface it rather
  // than silently under-reporting.
  if (added < toCreate.length) {
    console.warn(`[commitImport] ${toCreate.length - added} row(s) skipped by the DB serialNumber unique constraint (concurrent import or casing variant).`);
  }

  return { added, skipped, detected };
}
