import { newItemSchema, type NewItemInput } from "./items.schema";
import type { RawRow } from "./csv";

export type SkippedRow = { row: number; serialNumber: string; reason: string };

// Pure planning: validate each row, then dedup against the DB and within the
// file (first occurrence wins). Serial comparison is case-sensitive on the
// trimmed value the schema produces.
export function planImport(
  rows: RawRow[],
  existingSerials: Set<string>
): { toCreate: NewItemInput[]; skipped: SkippedRow[] } {
  const toCreate: NewItemInput[] = [];
  const skipped: SkippedRow[] = [];
  const seen = new Set<string>();

  for (const r of rows) {
    const parsed = newItemSchema.safeParse({
      make: r.make,
      model: r.model,
      serialNumber: r.serialNumber,
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
    toCreate.push(parsed.data);
  }
  return { toCreate, skipped };
}
