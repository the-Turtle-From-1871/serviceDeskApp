import { z } from "zod";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";

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
