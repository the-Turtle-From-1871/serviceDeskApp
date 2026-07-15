import { z } from "zod";
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

// Validate the whole batch before writing anything, then upsert each unit by
// its uppercase abbreviation so re-teaching an existing code updates its name.
export async function learnUnits(resolutions: UnitResolution[]): Promise<void> {
  const parsed = z.array(resolutionSchema).parse(resolutions);
  for (const r of parsed) {
    const abbreviation = r.abbreviation.toUpperCase();
    await prisma.unit.upsert({
      where: { abbreviation },
      update: { fullName: r.fullName },
      create: { abbreviation, fullName: r.fullName },
    });
  }
}

// Units for the item-detail unit picker's <datalist>, ordered for display.
export function listUnits(): Promise<{ abbreviation: string; fullName: string }[]> {
  return prisma.unit.findMany({
    select: { abbreviation: true, fullName: true },
    orderBy: { fullName: "asc" },
  });
}
