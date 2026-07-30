import { z } from "zod";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { ItemError } from "./items.errors";
import { diffItemFields } from "./item-diff";

export const resolutionSchema = z.object({
  abbreviation: z
    .string()
    .trim()
    .min(1, "Abbreviation is required")
    .regex(/^[A-Za-z0-9]+$/, "Abbreviation must be letters and digits only"),
  fullName: z.string().trim().min(1, "Unit name is required"),
});
export type UnitResolution = z.infer<typeof resolutionSchema>;

export async function loadUnitMap(): Promise<Map<string, string>> {
  const units = await prisma.unit.findMany({ select: { abbreviation: true, fullName: true } });
  return new Map(units.map((u) => [u.abbreviation.toUpperCase(), u.fullName]));
}

/**
 * Register or re-teach unit abbreviations.
 *
 * THREE queries regardless of how many units are passed — never one per row.
 * The old implementation was a `for` loop of `prisma.unit.upsert`, i.e. one
 * network round trip per row against a hosted database; a bulk paste of
 * dozens of units from /admin/units would be dozens of sequential round
 * trips, and that pattern is what made large imports slow/time out.
 *
 * Abbreviations are stored uppercased. The column is citext so lookups
 * already ignore case, but normalising on write keeps the stored form
 * consistent for display.
 */
export async function learnUnits(
  resolutions: UnitResolution[],
  tx: Prisma.TransactionClient = prisma,
): Promise<void> {
  const parsed = z.array(resolutionSchema).parse(resolutions);
  if (parsed.length === 0) return;

  // Last write wins on a duplicate abbreviation within one batch.
  const wanted = new Map<string, string>();
  for (const r of parsed) wanted.set(r.abbreviation.toUpperCase(), r.fullName);

  const abbreviations = [...wanted.keys()];

  // 1. What already exists (citext, so this matches regardless of casing).
  const existing = await tx.unit.findMany({
    where: { abbreviation: { in: abbreviations } },
    select: { abbreviation: true, fullName: true },
  });
  const existingByAbbrev = new Map(existing.map((u) => [u.abbreviation.toUpperCase(), u.fullName]));

  // 2. Insert the ones that are new. skipDuplicates leans on the unique index
  //    as the race-safe backstop against a concurrent import adding the same
  //    abbreviation between the read above and this write.
  const toCreate = abbreviations
    .filter((a) => !existingByAbbrev.has(a))
    .map((a) => ({ abbreviation: a, fullName: wanted.get(a)! }));
  if (toCreate.length > 0) {
    await tx.unit.createMany({ data: toCreate, skipDuplicates: true });
  }

  // 3. Update only the ones whose name actually changed — one updateMany per
  //    distinct new name, which is bounded by the number of CHANGED units, not
  //    by the batch size. Writing no statement at all when nothing changed is
  //    what makes a no-op re-teach free.
  const changed = abbreviations.filter(
    (a) => existingByAbbrev.has(a) && existingByAbbrev.get(a) !== wanted.get(a),
  );
  const byNewName = new Map<string, string[]>();
  for (const a of changed) {
    const name = wanted.get(a)!;
    byNewName.set(name, [...(byNewName.get(name) ?? []), a]);
  }
  for (const [fullName, abbrevs] of byNewName) {
    await tx.unit.updateMany({ where: { abbreviation: { in: abbrevs } }, data: { fullName } });
  }
}

// Units for the item-detail unit picker's <datalist>, ordered for display.
export function listUnits(): Promise<{ abbreviation: string; fullName: string }[]> {
  return prisma.unit.findMany({
    select: { abbreviation: true, fullName: true },
    orderBy: { fullName: "asc" },
  });
}

/* ============================================================
   The managed unit vocabulary (admin CRUD).

   Unit has no FK to Item — Item.homeUnit is a denormalised copy of
   Unit.fullName, written verbatim by the CSV importer (see loadUnitMap /
   the import path). That means this module owns keeping the two coherent:
   renaming a unit must rewrite every item carrying the old spelling, or the
   fleet ends up holding two spellings of one unit, which shows up as TWO
   entries in the /items unit filter and TWO bars in the analytics unit
   leaderboard for what is really one unit. Deleting a unit still in use
   would leave those devices holding a string that matches no vocabulary
   row, so it is refused instead, mirroring deleteCategory.
   ============================================================ */

export type UnitRow = { id: string; abbreviation: string; fullName: string; itemCount: number };

/**
 * Every unit with the number of items whose homeUnit carries its full name.
 *
 * TWO queries regardless of unit count: the list, then ONE groupBy over
 * items — never a count query per unit. Mirrors listCategoriesWithCounts.
 */
export async function listUnitsWithCounts(): Promise<UnitRow[]> {
  const [units, counts] = await Promise.all([
    prisma.unit.findMany({
      select: { id: true, abbreviation: true, fullName: true },
      orderBy: { fullName: "asc" },
    }),
    prisma.item.groupBy({
      by: ["homeUnit"],
      where: { homeUnit: { not: null } },
      _count: { _all: true },
    }),
  ]);

  // Item.homeUnit is plain text and so is Unit.fullName (unlike
  // DeviceCategory.name, it is NOT citext) — but the value is written
  // verbatim from Unit.fullName at import time, so an exact (trimmed)
  // match is the correct comparison here, not a case-insensitive one.
  const byName = new Map<string, number>();
  for (const c of counts) {
    if (!c.homeUnit) continue;
    const key = c.homeUnit.trim();
    byName.set(key, (byName.get(key) ?? 0) + c._count._all);
  }

  return units.map((u) => ({
    ...u,
    itemCount: byName.get(u.fullName.trim()) ?? 0,
  }));
}

/** How many items would a rename of this full name touch. Used to warn the
 *  admin BEFORE they commit a change that rewrites a thousand rows. */
export async function countItemsWithHomeUnit(fullName: string): Promise<number> {
  return prisma.item.count({ where: { homeUnit: fullName } });
}

/**
 * Correct a unit's full name, and rewrite every item carrying the old one.
 *
 * WHY THE BACKFILL: Unit has no FK to Item — Item.homeUnit is a denormalised
 * copy of Unit.fullName, written at import time. Renaming only the
 * vocabulary row would leave the fleet holding the old spelling, splitting
 * one real unit into two entries in the /items filter and two bars in the
 * analytics leaderboard.
 *
 * A FIXED number of queries in one transaction, never one per item: a read
 * of the affected item ids, the unit's own update, one updateMany of the
 * items, and one createMany of history rows. homeUnit is already a member
 * of ItemLoggedFields, so these rows are shaped exactly like a hand edit —
 * the diff is identical for every affected item (same before/after), so it
 * is computed once rather than per row.
 */
export async function renameUnit(
  id: string,
  rawFullName: string,
  editor: { id: string; name: string },
): Promise<{ abbreviation: string; itemsUpdated: number }> {
  const fullName = rawFullName.trim();
  if (!fullName) throw new ItemError("INVALID", "Enter a unit name.");

  const unit = await prisma.unit.findUnique({
    where: { id },
    select: { abbreviation: true, fullName: true },
  });
  if (!unit) throw new ItemError("NOT_FOUND", "That unit no longer exists.");
  if (unit.fullName === fullName) return { abbreviation: unit.abbreviation, itemsUpdated: 0 };

  return prisma.$transaction(async (tx) => {
    const affected = await tx.item.findMany({
      where: { homeUnit: unit.fullName },
      select: { id: true },
    });

    await tx.unit.update({ where: { id }, data: { fullName } });

    if (affected.length > 0) {
      await tx.item.updateMany({
        where: { id: { in: affected.map((a) => a.id) } },
        data: { homeUnit: fullName },
      });

      const changes = diffItemFields(
        { homeUnit: unit.fullName },
        { homeUnit: fullName },
      ) as unknown as Prisma.InputJsonValue;
      await tx.itemEdit.createMany({
        data: affected.map((a) => ({
          itemId: a.id,
          editedById: editor.id,
          editedByName: editor.name,
          changes,
        })),
      });
    }

    return { abbreviation: unit.abbreviation, itemsUpdated: affected.length };
  });
}

/**
 * Remove a unit from the vocabulary.
 *
 * REFUSED while items still carry its full name, mirroring deleteCategory.
 * With no FK, deleting an in-use unit leaves those devices holding a string
 * that appears in no picker and stops the importer resolving the
 * abbreviation to anything meaningful.
 *
 * Plain Prisma equality, NOT deleteCategory's raw-SQL LOWER(btrim(...))
 * comparison — that treatment exists there because DeviceCategory.name is
 * citext and Prisma's `mode: "insensitive"` compiles to ILIKE, which turns
 * `_`/`%` inside the name into wildcards. Unit.fullName is a plain String
 * column, not citext (see schema.prisma), and this check is not asking for
 * case-insensitivity at all — it is an exact match against a value that was
 * itself written verbatim from this same fullName at import time. A plain
 * `=` comparison has no ILIKE wildcard behavior, so there is nothing here
 * for that treatment to guard against.
 */
export async function deleteUnit(id: string): Promise<{ abbreviation: string }> {
  const unit = await prisma.unit.findUnique({
    where: { id },
    select: { abbreviation: true, fullName: true },
  });
  if (!unit) throw new ItemError("NOT_FOUND", "That unit no longer exists.");

  const inUse = await prisma.item.count({ where: { homeUnit: unit.fullName } });
  if (inUse > 0) {
    throw new ItemError(
      "IN_USE",
      `"${unit.fullName}" is still the home unit of ${inUse} item${inUse === 1 ? "" : "s"}. ` +
        "Reassign them first, then remove it.",
    );
  }

  await prisma.unit.delete({ where: { id } });
  return { abbreviation: unit.abbreviation };
}
