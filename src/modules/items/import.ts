import { newItemSchema, type NewItemInput } from "./items.schema";
import type { RawRow } from "./csv";
import { detectHomeUnit, splitSegments } from "./unit-detect";

export type SkippedRow = { row: number; serialNumber: string; reason: string };
export type UnresolvedRow = { row: number; deviceName: string; segments: string[] };

// Pure planning: validate each row, dedup against the DB and within the file
// (first occurrence wins), then — only when homeUnit is blank — derive it from
// the device name. Rows whose device name matches no known unit are returned in
// `unresolved` (they still import, with an empty homeUnit).
export function planImport(
  rows: RawRow[],
  // Must be LOWERCASED by the caller — dedup is case-insensitive (citext).
  existingSerials: Set<string>,
  unitsByAbbrev: Map<string, string>,
): { toCreate: NewItemInput[]; skipped: SkippedRow[]; unresolved: UnresolvedRow[]; detected: number } {
  const toCreate: NewItemInput[] = [];
  const skipped: SkippedRow[] = [];
  const unresolved: UnresolvedRow[] = [];
  const seen = new Set<string>();
  let detected = 0;

  for (const r of rows) {
    const parsed = newItemSchema.safeParse({
      make: r.make,
      model: r.model,
      serialNumber: r.serialNumber,
      deviceName: r.deviceName,
      homeUnit: r.homeUnit,
      notes: r.notes,
    });
    if (!parsed.success) {
      skipped.push({ row: r.row, serialNumber: r.serialNumber, reason: parsed.error.issues[0]?.message ?? "invalid row" });
      continue;
    }
    const sn = parsed.data.serialNumber;
    // Dedup case-insensitively to match the DB's citext unique on serialNumber:
    // "ABC123" and "abc123" are the same device. The stored value keeps its
    // original casing; only the comparison is normalized. `existingSerials` is
    // passed in already lowercased by the caller.
    const snKey = sn.toLowerCase();
    if (existingSerials.has(snKey)) {
      skipped.push({ row: r.row, serialNumber: sn, reason: "already exists" });
      continue;
    }
    if (seen.has(snKey)) {
      skipped.push({ row: r.row, serialNumber: sn, reason: "duplicate in file" });
      continue;
    }
    seen.add(snKey);

    if (!parsed.data.homeUnit) {
      const full = detectHomeUnit(parsed.data.deviceName, unitsByAbbrev);
      if (full) {
        parsed.data.homeUnit = full;
        detected++;
      } else {
        unresolved.push({ row: r.row, deviceName: parsed.data.deviceName, segments: splitSegments(parsed.data.deviceName) });
      }
    }

    toCreate.push(parsed.data);
  }
  return { toCreate, skipped, unresolved, detected };
}
