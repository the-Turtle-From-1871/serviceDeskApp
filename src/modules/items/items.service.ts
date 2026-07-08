import type { Item, ItemStatus, Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { newItemSchema, type NewItemInput } from "./items.schema";
import { parseItemsCsv } from "./csv";
import { planImport, type SkippedRow } from "./import";

export async function createItem(input: NewItemInput, createdById: string): Promise<Item> {
  const data = newItemSchema.parse(input);
  return prisma.item.create({ data: { ...data, createdById } });
}

export function getItem(id: string) {
  return prisma.item.findUnique({ where: { id } });
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

export async function importItems(
  text: string,
  filename: string,
  createdById: string
): Promise<{ added: number; skipped: SkippedRow[]; error?: string }> {
  const { rows, error } = parseItemsCsv(text);
  if (error) return { added: 0, skipped: [], error };

  const existing = new Set(
    (await prisma.item.findMany({ select: { serialNumber: true } })).map((i) => i.serialNumber)
  );
  const { toCreate, skipped } = planImport(rows, existing);

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

  return { added: toCreate.length, skipped };
}
