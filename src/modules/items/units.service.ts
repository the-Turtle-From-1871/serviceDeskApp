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
): Promise<{ created: number; updated: number }> {
  const parsed = z.array(resolutionSchema).parse(resolutions);
  if (parsed.length === 0) return { created: 0, updated: 0 };

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

  return { created: toCreate.length, updated: changed.length };
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
   database through FOUR different write paths, only one of which is an
   exact copy of Unit.fullName:
     1. detectHomeUnit (import.ts) — derived from the device name and
        assigned Unit.fullName verbatim, but ONLY when the CSV's own
        homeUnit column was blank.
     2. CSV passthrough (import.ts, importRowSchema.homeUnit) — the CSV's
        homeUnit column is copied through, whatever casing the property
        book's spreadsheet happened to contain.
     3. Item creation (newItemSchema.homeUnit, items.schema.ts) — free text
        typed at creation time, casing uncontrolled.
     4. Hand edit — homeUnit is one of the seven admin-editable fields
        (editableItemFields, items.schema.ts), settable free-text from both
        `/admin/items/<id>/edit` and the item detail card.
   CASE is the thing that actually drifts across paths 2-4: none of them
   assigns Unit.fullName verbatim, so whatever casing a spreadsheet cell or
   an admin's keystrokes happened to use is what lands in the column. That
   is exactly what a rename or delete needs to catch: missing it is what
   would let the fleet keep holding a second spelling of a unit that was
   supposedly just renamed, or let deleteUnit remove a unit while a
   differently-cased row still points at it.
     WHITESPACE, by contrast, is NOT a live path today — all four schemas
   above (`optional` / `clearable` in items.schema.ts) call `.trim()` before
   the value ever reaches Prisma, so no current write can store a padded
   value. The comparisons below still wrap both sides in `btrim(...)` as
   defence for legacy rows written before that normalization existed, or a
   future direct-SQL/import-tool write that bypasses these schemas — not
   because any current code path produces padding.
   Every comparison below is therefore LOWER(btrim(...)) on BOTH sides,
   values bound (never interpolated) — mirroring deleteCategory in
   categories.service.ts, which needs the LOWER() half for a parallel reason
   (DeviceCategory.name is citext and Item.deviceCategory is free text
   written the same uncontrolled way).

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
 *
 * Each unit's fullName is bound into the second query (a VALUES list via
 * Prisma.join, never spliced) and matched with LOWER(btrim(...)) entirely in
 * SQL on BOTH sides. Folding the unit side in JS (`fullName.toLowerCase()`)
 * instead would let Postgres and JS disagree on non-ASCII case folding,
 * which would show itemCount: 0 for a unit deleteUnit still refuses to
 * remove — the exact three-sites disagreement this module's design exists
 * to prevent. One engine decides, so the count and the delete guard can
 * never drift apart.
 *
 * The VALUES list is built from the DISTINCT fullNames, not one row per
 * unit. There is no unique constraint on `Unit.fullName` (deliberately
 * carried — see the module comment), so two units can share one fullName;
 * a VALUES row per UNIT would put two identical rows in the list, and the
 * LEFT JOIN would then match each carrying item TWICE (once per identical
 * VALUES row) before GROUP BY collapsed them back onto one key — both
 * units would report itemCount 2N instead of N, exactly the divergence
 * from deleteUnit's count (which does not have this bug) that this module
 * exists to prevent. One VALUES row per distinct name keeps the join 1:1
 * regardless of how many units share it; every unit with that fullName
 * then reads the same, correct count out of the map below.
 *
 * Bind parameters scale one per DISTINCT fullName — fine for a curated
 * vocabulary (nowhere near Postgres's 65,535 ceiling). Contrast the CSV
 * importer's UPDATE_CHUNK_ROWS in items.service.ts, which exists precisely
 * because THAT list scales with import size, not with a managed list.
 */
export async function listUnitsWithCounts(): Promise<UnitRow[]> {
  const units = await prisma.unit.findMany({
    select: { id: true, abbreviation: true, fullName: true },
    orderBy: { fullName: "asc" },
  });
  if (units.length === 0) return [];

  const distinctNames = [...new Set(units.map((u) => u.fullName))];

  const counts = await prisma.$queryRaw<{ key: string; count: bigint }[]>(Prisma.sql`
    SELECT v.full_name AS key, COUNT(i.id)::bigint AS count
    FROM (VALUES ${Prisma.join(distinctNames.map((n) => Prisma.sql`(${n})`))}) AS v(full_name)
    LEFT JOIN "Item" i
      ON i."homeUnit" IS NOT NULL
      AND LOWER(btrim(i."homeUnit")) = LOWER(btrim(v.full_name))
    GROUP BY v.full_name
  `);

  const byKey = new Map(counts.map((c) => [c.key, Number(c.count)]));

  return units.map((u) => ({
    ...u,
    itemCount: byKey.get(u.fullName) ?? 0,
  }));
}

// Shared by both queries below so the capped sample and the true count can
// never drift onto two different definitions of "unassigned" — see the
// docstring on listUnassignedHomeUnits for why that would be its own bug.
const UNASSIGNED_HOME_UNIT_WHERE = {
  homeUnit: null,
  deviceName: { not: null },
  status: "ACTIVE",
} as const satisfies Prisma.ItemWhereInput;

/**
 * Items the importer could not derive a home unit for.
 *
 * Returns a BOUNDED sample (`take` only, never an unbounded `findMany` over
 * Item — 1,200+ rows and growing) alongside the TRUE total, from one
 * `findMany` + one `count` sharing the identical `where` — TWO queries,
 * fixed, regardless of fleet size. The sample lets an admin spot the pattern
 * (usually one new abbreviation shared by many devices) and teach it above;
 * it is not a worklist meant to enumerate every unresolved row. Showing only
 * `items.length` as if it were the total undercounts once the real number
 * exceeds `limit` — the caller must show `total` and note when the list is
 * a partial sample.
 *
 * `select` pulls only id + deviceName — no notes, holder PII, or signature
 * data belongs in this list.
 */
export async function listUnassignedHomeUnits(
  limit = 50,
): Promise<{ items: { id: string; deviceName: string }[]; total: number }> {
  const [rows, total] = await Promise.all([
    prisma.item.findMany({
      where: UNASSIGNED_HOME_UNIT_WHERE,
      select: { id: true, deviceName: true },
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    prisma.item.count({ where: UNASSIGNED_HOME_UNIT_WHERE }),
  ]);
  return {
    items: rows.map((r) => ({ id: r.id, deviceName: r.deviceName! })),
    total,
  };
}

/**
 * When the fleet was last refreshed by an import.
 *
 * WHY THIS IS SHOWN: the nightly automated import runs with nobody watching
 * it. A scheduled job that quietly dies looks identical, from the app's
 * point of view, to a fleet that has simply stopped changing — there is no
 * error to see, just silence. A visible "last imported" timestamp (and a
 * stale-after-48h warning, applied by the caller) is the cheapest way for
 * that kind of failure to surface in days instead of weeks.
 */
export async function lastImportAt(): Promise<Date | null> {
  const batch = await prisma.importBatch.findFirst({
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  return batch?.createdAt ?? null;
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
 * module comment) because homeUnit reaches Item via four write paths, and
 * only ONE of them assigns Unit.fullName verbatim — a differently-CASED row
 * must still be found and rewritten, or it survives the rename as a second
 * spelling (`btrim` is defensive; no current write path pads with
 * whitespace). Prisma's `updateMany`/`groupBy` can't express that predicate,
 * so the read and the write are raw SQL; ids are bound via Prisma.join,
 * never spliced in.
 *
 * A FIXED number of queries in one transaction, never one per item: a read
 * of the affected items (id + their OWN stored value, needed because two
 * affected rows can differ from each other in case even though both match
 * the old name), the unit's own update, one raw UPDATE of the items, and
 * one createMany of history rows. homeUnit is already a member of
 * ItemLoggedFields, so these rows are shaped exactly like a hand edit. Each
 * row's diff uses ITS OWN prior value as `from` (not the unit's canonical
 * fullName), so the history reflects what was actually stored.
 *
 * A row whose stored value ALREADY equals the new name once diffItemFields
 * normalizes it (trim; e.g. the rename is really "fix the casing", and some
 * items already had the target casing) gets NO history row and is NOT
 * counted in itemsUpdated — filtered from the already-read `affected` array
 * in JS, no extra query. Writing a blank-`changes` ItemEdit for a row that
 * didn't actually change would render as an empty "Changed" cell on
 * /admin/audit and would inflate itemsUpdated past the real count. The bulk
 * UPDATE above still touches those rows too (harmless: it writes the same
 * value they already had) — only the history row and the count must not lie.
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

    if (affected.length === 0) {
      return { abbreviation: unit.abbreviation, itemsUpdated: 0 };
    }

    const ids = affected.map((a) => a.id);
    await tx.$executeRaw(Prisma.sql`
      UPDATE "Item"
      SET "homeUnit" = ${fullName}
      WHERE id IN (${Prisma.join(ids)})
    `);

    // Only rows whose normalized value actually differs get a history row —
    // see the docstring above for why a same-spelling row must not.
    const edits = affected
      .map((a) => ({
        itemId: a.id,
        changes: diffItemFields({ homeUnit: a.homeUnit }, { homeUnit: fullName }),
      }))
      .filter((e) => e.changes.length > 0);

    if (edits.length > 0) {
      await tx.itemEdit.createMany({
        data: edits.map((e) => ({
          itemId: e.itemId,
          editedById: editor.id,
          editedByName: editor.name,
          changes: e.changes as unknown as Prisma.InputJsonValue,
        })),
      });
    }

    return { abbreviation: unit.abbreviation, itemsUpdated: edits.length };
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
 * Item.homeUnit reaches this column via four write paths, only one of which
 * assigns Unit.fullName verbatim, so a case-sensitive check would miss a
 * differently-CASED row and delete a unit that a device still, in effect,
 * points at (`btrim` is defensive here too — no current write path pads
 * with whitespace).
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
