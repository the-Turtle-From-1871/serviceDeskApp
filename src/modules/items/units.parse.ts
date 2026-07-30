import { resolutionSchema, type UnitResolution } from "./units.service";

/**
 * Parse a pasted block of `ABBREV,Full Name` lines.
 *
 * Deliberately its OWN module rather than living in
 * src/app/admin/actions/units.ts: that file starts with "use server", and
 * Next.js requires every export from a "use server" module to be an async
 * function — a synchronous export there is a build error, not a lint nit.
 * Keeping this here also keeps it pure (no Prisma, no `server-only`), so it
 * stays unit-testable without a database.
 *
 * Reports bad lines by NUMBER instead of dropping them: a silently ignored
 * line in a paste of fifty is exactly the kind of thing nobody notices until
 * a unit is missing.
 */
export function parseUnitBlock(raw: string): { units: UnitResolution[]; errors: string[] } {
  const units: UnitResolution[] = [];
  const errors: string[] = [];

  raw.split(/\r?\n/).forEach((line, i) => {
    const text = line.trim();
    if (!text) return;
    const comma = text.indexOf(",");
    if (comma === -1) {
      errors.push(`Line ${i + 1}: expected "ABBREVIATION,Unit name".`);
      return;
    }
    const candidate = {
      abbreviation: text.slice(0, comma).trim(),
      fullName: text.slice(comma + 1).trim(),
    };
    const parsed = resolutionSchema.safeParse(candidate);
    if (!parsed.success) {
      errors.push(`Line ${i + 1}: ${parsed.error.issues[0]?.message ?? "invalid"}.`);
      return;
    }
    units.push(parsed.data);
  });

  return { units, errors };
}
