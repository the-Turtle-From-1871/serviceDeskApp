import "server-only";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { ItemError } from "./items.errors";
import { MAX_CATEGORY_NAME, normalizeCategoryName } from "./items.schema";

// Re-exported so callers have one import site for the vocabulary API. The
// implementation lives in items.schema.ts because it must be reachable from
// pure/validation code that cannot import a `server-only` module.
export { normalizeCategoryName, MAX_CATEGORY_NAME };

/* ============================================================
   The managed device-category vocabulary.

   `DeviceCategory` is the curated LIST; `Item.deviceCategory` is the value
   actually stored on a device. They are deliberately not joined by a foreign
   key — see the model comment in schema.prisma. That means this module owns
   keeping the two coherent:

     - deletion is refused while any item still carries the name, so removing
       a category can never orphan a device into a category the admin can no
       longer see or re-select;
     - the CSV importer teaches new names into the list (learnCategories), the
       same way unit abbreviations are learned, so an import can never fail on
       an unregistered category.
   ============================================================ */

export type CategoryRow = { id: string; name: string; itemCount: number };

/**
 * Every category with the number of items using it.
 *
 * TWO queries regardless of category count: the list, then ONE `groupBy` over
 * items — never a count query per category.
 */
export async function listCategoriesWithCounts(): Promise<CategoryRow[]> {
  const [categories, counts] = await Promise.all([
    prisma.deviceCategory.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.item.groupBy({
      by: ["deviceCategory"],
      where: { deviceCategory: { not: null } },
      _count: { _all: true },
    }),
  ]);

  // Item.deviceCategory is plain text while DeviceCategory.name is citext, so
  // match on a lowercased key rather than trusting the two casings to agree.
  const byName = new Map<string, number>();
  for (const c of counts) {
    if (!c.deviceCategory) continue;
    const key = normalizeCategoryName(c.deviceCategory).toLowerCase();
    byName.set(key, (byName.get(key) ?? 0) + c._count._all);
  }

  return categories.map((c) => ({
    id: c.id,
    name: c.name,
    itemCount: byName.get(normalizeCategoryName(c.name).toLowerCase()) ?? 0,
  }));
}

/** Just the names, for the item edit form's picker. */
export async function listCategoryNames(): Promise<string[]> {
  const rows = await prisma.deviceCategory.findMany({
    select: { name: true },
    orderBy: { name: "asc" },
  });
  return rows.map((r) => r.name);
}

export async function createCategory(rawName: string, createdById: string): Promise<{ name: string }> {
  const name = normalizeCategoryName(rawName);
  if (!name) throw new ItemError("INVALID", "Enter a category name.");
  if (name.length > MAX_CATEGORY_NAME) {
    throw new ItemError("INVALID", `Category names are limited to ${MAX_CATEGORY_NAME} characters.`);
  }
  try {
    const created = await prisma.deviceCategory.create({
      data: { name, createdById },
      select: { name: true },
    });
    return created;
  } catch (e) {
    // Lean on the unique index rather than a check-then-insert, which races.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new ItemError("DUPLICATE", `"${name}" already exists.`);
    }
    throw e;
  }
}

/**
 * Remove a category from the vocabulary.
 *
 * REFUSED while items still carry it. Because there is no FK, deleting an
 * in-use category would leave those devices holding a string that no longer
 * appears in any picker — invisible-but-present data. Making the admin
 * re-categorize first is the honest order of operations.
 */
export async function deleteCategory(id: string): Promise<{ name: string }> {
  const category = await prisma.deviceCategory.findUnique({ where: { id }, select: { name: true } });
  if (!category) throw new ItemError("NOT_FOUND", "That category no longer exists.");

  // NOT `mode: "insensitive"`. Prisma compiles that to ILIKE, which treats `_`
  // and `%` inside the name as WILDCARDS — a category called "Laptop_A" would
  // match "LaptopXA", and one called "%" would match every categorised item,
  // so the refusal could fire (or fail to fire) on the wrong rows. LOWER() on
  // both sides is an exact comparison that still ignores case, matching the
  // citext semantics of DeviceCategory.name. Parameterized, never interpolated.
  const [{ count }] = await prisma.$queryRaw<[{ count: bigint }]>(Prisma.sql`
    SELECT COUNT(*)::bigint AS count
    FROM "Item"
    WHERE LOWER(btrim("deviceCategory")) = LOWER(${category.name})
  `);
  const inUse = Number(count);
  if (inUse > 0) {
    throw new ItemError(
      "IN_USE",
      `"${category.name}" is still assigned to ${inUse} item${inUse === 1 ? "" : "s"}. ` +
        "Re-categorize them first, then remove it.",
    );
  }

  await prisma.deviceCategory.delete({ where: { id } });
  return category;
}

/**
 * Register any category names an import introduced that aren't in the list yet.
 *
 * Mirrors `learnUnits`: the import is never blocked by an unknown category, and
 * the admin list stays a true reflection of what is actually in the fleet.
 * ONE createMany with skipDuplicates — the unique index is the race-safe
 * backstop against a concurrent import adding the same name.
 */
export async function learnCategories(
  names: Array<string | null | undefined>,
  tx: Prisma.TransactionClient = prisma,
): Promise<number> {
  const wanted = new Map<string, string>();
  for (const raw of names) {
    if (!raw) continue;
    const name = normalizeCategoryName(raw);
    if (!name || name.length > MAX_CATEGORY_NAME) continue;
    wanted.set(name.toLowerCase(), name);
  }
  if (wanted.size === 0) return 0;

  const res = await tx.deviceCategory.createMany({
    data: [...wanted.values()].map((name) => ({ name })),
    skipDuplicates: true,
  });
  return res.count;
}
