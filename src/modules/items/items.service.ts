import type { Item, ItemStatus, Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { newItemSchema, type NewItemInput } from "./items.schema";
import { parseItemsCsv } from "./csv";
import { planImport, type SkippedRow, type UnresolvedRow } from "./import";
import { loadUnitMap, learnUnits, type UnitResolution } from "./units.service";

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

export function listItems(opts: { search?: string } = {}) {
  const search = opts.search?.trim();
  return prisma.item.findMany({
    where: search
      ? {
          OR: [
            { make: { contains: search, mode: "insensitive" } },
            { model: { contains: search, mode: "insensitive" } },
            { serialNumber: { contains: search, mode: "insensitive" } },
          ],
        }
      : undefined,
    orderBy: { createdAt: "desc" },
  });
}

export async function updateItem(id: string, input: Partial<NewItemInput>): Promise<Item> {
  const data = newItemSchema.partial().parse(input);
  return prisma.item.update({ where: { id }, data });
}

export function setItemStatus(id: string, status: ItemStatus): Promise<Item> {
  return prisma.item.update({ where: { id }, data: { status } });
}

export function retireItem(id: string): Promise<Item> {
  return setItemStatus(id, "RETIRED");
}

export function searchItemsBySerial(q: string): Promise<Item[]> {
  const s = q.trim();
  if (!s) return Promise.resolve([]);
  return prisma.item.findMany({
    where: { serialNumber: { contains: s, mode: "insensitive" } },
    orderBy: { createdAt: "desc" },
    take: 50, // bound the public result set (a 1-char query would otherwise scan all items)
  });
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
    (await prisma.item.findMany({ select: { serialNumber: true } })).map((i) => i.serialNumber)
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
    (await prisma.item.findMany({ select: { serialNumber: true } })).map((i) => i.serialNumber)
  );
  const units = await loadUnitMap();
  const { toCreate, skipped, detected } = planImport(rows, existing, units);

  await prisma.$transaction([
    prisma.item.createMany({ data: toCreate.map((d) => ({ ...d, createdById })) }),
    prisma.importBatch.create({
      data: {
        createdById,
        filename,
        addedCount: toCreate.length,
        skippedCount: skipped.length,
        skipped: skipped as unknown as Prisma.InputJsonValue,
      },
    }),
  ]);

  return { added: toCreate.length, skipped, detected };
}
