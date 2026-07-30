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
   Unit.fullName. Unlike learnUnits' own callers, Item.homeUnit reaches the
   database through THREE different paths, only one of which is an exact
   copy of Unit.fullName:
     1. detectHomeUnit (import.ts) — derived from the device name and
        assigned Unit.fullName verbatim, but ONLY when the CSV's own
        homeUnit column was blank.
     2. CSV passthrough (import.ts) — the CSV's homeUnit column is copied
        straight through UNMODIFIED (whatever casing/whitespace the property
        book's spreadsheet happened to contain).
     3. Hand edit — homeUnit is one of the seven admin-editable fields
        (editableItemFields, items.schema.ts), settable free-text from both
        `/admin/items/<id>/edit` and the item detail card.
   Paths 2 and 3 mean arbitrary case and stray whitespace genuinely reach
   this column, so a case-sensitive/whitespace-sensitive comparison against
   Unit.fullName cannot see those rows. That is exactly the case a rename or
   delete needs to catch: missing it here is what would let the fleet keep
   holding a second spelling of a unit that was supposedly just renamed, or
   let deleteUnit remove a unit while a differently-cased row still points
   at it. Every comparison below is therefore LOWER(btrim(...)) on BOTH
   sides, values bound (never interpolated) — mirroring deleteCategory in
   categories.service.ts, which needs the same treatment for the same
   reason (there, because DeviceCategory.name is citext and Item.deviceCategory
   is free text written the same three ways).

   With that comparison in place, renaming a unit must rewrite every item
   carrying the old spelling (in whatever casing it was actually stored),
   or the fleet ends up split across TWO entries in the /items unit filter
   and TWO bars in the analytics unit leaderboard for what is really one
   unit. Deleting a unit still in use would leave those devices holding a
   string that matches no vocabulary row, so it is refused instead.
   ============================================================ */

export type UnitRow = { id: string; abbreviation: string; fullName: string; itemCount: number };

/**
 * Every unit with the number of items whose homeUnit carries its full name
 * (case- and whitespace-insensitively — see the module comment above).
 *
 * TWO queries regardless of unit count: the list, then ONE grouped raw query
 * over items — never a count query per unit. Mirrors listCategoriesWithCounts,
 * except the grouping key itself has to be normalized in SQL (LOWER(btrim(...)))
 * rather than in JS, since a plain Prisma groupBy can't express that.
 */
export async function listUnitsWithCounts(): Promise<UnitRow[]> {
  const [units, counts] = await Promise.all([
    prisma.unit.findMany({
      select: { id: true, abbreviation: true, fullName: true },
      orderBy: { fullName: "asc" },
    }),
    prisma.$queryRaw<{ key: string; count: bigint }[]>(Prisma.sql`
      SELECT LOWER(btrim("homeUnit")) AS key, COUNT(*)::bigint AS count
      FROM "Item"
      WHERE "homeUnit" IS NOT NULL AND btrim("homeUnit") <> ''
      GROUP BY LOWER(btrim("homeUnit"))
    `),
  ]);

  const byKey = new Map(counts.map((c) => [c.key, Number(c.count)]));

  return units.map((u) => ({
    ...u,
    itemCount: byKey.get(u.fullName.trim().toLowerCase()) ?? 0,
  }));
}

/** How many items would a rename of this full name touch (case- and
 *  whitespace-insensitively). Used to warn the admin BEFORE they commit a
 *  change that rewrites a thousand rows. */
export async function countItemsWithHomeUnit(fullName: string): Promise<number> {
  const [{ count }] = await prisma.$queryRaw<[{ count: bigint }]>(Prisma.sql`
    SELECT COUNT(*)::bigint AS count
    FROM "Item"
    WHERE LOWER(btrim("homeUnit")) = LOWER(btrim(${fullName}))
  `);
  return Number(count);
}

/**
 * Correct a unit's full name, and rewrite every item carrying the old one.
 *
 * WHY THE BACKFILL: Unit has no FK to Item — Item.homeUnit is a denormalised
 * copy of Unit.fullName. Renaming only the vocabulary row would leave the
 * fleet holding the old spelling, splitting one real unit into two entries
 * in the /items filter and two bars in the analytics leaderboard.
 *
 * The match against the OLD name is LOWER(btrim(...)) on both sides (see the
 * module comment) because homeUnit reaches Item via CSV passthrough and hand
 * edits, not only as a verbatim copy of Unit.fullName — a differently-cased
 * or padded row must still be found and rewritten, or it survives the rename
 * as a second spelling. Prisma's `updateMany`/`groupBy` can't express that
 * predicate, so the read and the write are raw SQL; ids are bound via
 * Prisma.join, never spliced in.
 *
 * A FIXED number of queries in one transaction, never one per item: a read
 * of the affected items (id + their OWN stored value, needed because two
 * affected rows can differ from each other in case/whitespace even though
 * both match the old name), the unit's own update, one raw UPDATE of the
 * items, and one createMany of history rows. homeUnit is already a member
 * of ItemLoggedFields, so these rows are shaped exactly like a hand edit.
 * Each row's diff uses ITS OWN prior value as `from` (not the unit's
 * canonical fullName), so the history reflects what was actually stored.
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
    const affected = await tx.$queryRaw<{ id: string; homeUnit: string | null }[]>(Prisma.sql`
      SELECT id, "homeUnit"
      FROM "Item"
      WHERE LOWER(btrim("homeUnit")) = LOWER(btrim(${unit.fullName}))
    `);

    await tx.unit.update({ where: { id }, data: { fullName } });

    if (affected.length > 0) {
      const ids = affected.map((a) => a.id);
      await tx.$executeRaw(Prisma.sql`
        UPDATE "Item"
        SET "homeUnit" = ${fullName}
        WHERE id IN (${Prisma.join(ids)})
      `);

      await tx.itemEdit.createMany({
        data: affected.map((a) => ({
          itemId: a.id,
          editedById: editor.id,
          editedByName: editor.name,
          changes: diffItemFields(
            { homeUnit: a.homeUnit },
            { homeUnit: fullName },
          ) as unknown as Prisma.InputJsonValue,
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
 * LOWER(btrim(...)) on both sides, parameterized — same reasoning as
 * deleteCategory's raw-SQL comparison, and as the module comment above:
 * Item.homeUnit reaches this column via CSV passthrough and hand edits, not
 * only as an exact copy of Unit.fullName, so a case/whitespace-sensitive
 * check would miss a differently-cased row and delete a unit that a device
 * still, in effect, points at.
 */
export async function deleteUnit(id: string): Promise<{ abbreviation: string }> {
  const unit = await prisma.unit.findUnique({
    where: { id },
    select: { abbreviation: true, fullName: true },
  });
  if (!unit) throw new ItemError("NOT_FOUND", "That unit no longer exists.");

  const [{ count }] = await prisma.$queryRaw<[{ count: bigint }]>(Prisma.sql`
    SELECT COUNT(*)::bigint AS count
    FROM "Item"
    WHERE LOWER(btrim("homeUnit")) = LOWER(btrim(${unit.fullName}))
  `);
  const inUse = Number(count);
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
