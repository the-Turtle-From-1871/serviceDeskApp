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
    if (existingSerials.has(sn)) {
      skipped.push({ row: r.row, serialNumber: sn, reason: "already exists" });
      continue;
    }
    if (seen.has(sn)) {
      skipped.push({ row: r.row, serialNumber: sn, reason: "duplicate in file" });
      continue;
    }
    seen.add(sn);

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
