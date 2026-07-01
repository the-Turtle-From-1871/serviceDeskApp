import type { Item } from "@prisma/client";
import prisma from "@/lib/prisma";
import { newItemSchema, type NewItemInput } from "./items.schema";

export type ItemWithHolder = Awaited<ReturnType<typeof getItem>>;

export async function createItem(input: NewItemInput, createdById: string): Promise<Item> {
  const data = newItemSchema.parse(input);
  return prisma.item.create({ data: { ...data, createdById } });
}

export function getItem(id: string) {
  return prisma.item.findUnique({
    where: { id },
    include: { currentHolder: { select: { id: true, name: true } } },
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
            { assetTag: { contains: search, mode: "insensitive" } },
          ],
        }
      : undefined,
    include: { currentHolder: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" },
  });
}

export async function updateItem(id: string, input: Partial<NewItemInput>): Promise<Item> {
  const data = newItemSchema.partial().parse(input);
  return prisma.item.update({ where: { id }, data });
}

export function retireItem(id: string): Promise<Item> {
  return prisma.item.update({ where: { id }, data: { status: "RETIRED" } });
}
