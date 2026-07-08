import { parse } from "csv-parse/sync";

export const MAX_IMPORT_ROWS = 2000;

export type RawRow = {
  row: number;
  make: string;
  model: string;
  serialNumber: string;
  homeUnit: string;
  notes: string;
};

// Map a normalized (lowercased, alphanumeric-only) header to a canonical field.
const HEADER_MAP: Record<string, keyof Omit<RawRow, "row">> = {
  make: "make",
  model: "model",
  serialnumber: "serialNumber",
  serial: "serialNumber",
  homeunit: "homeUnit",
  notes: "notes",
};

const normalizeHeader = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

export function parseItemsCsv(text: string): { rows: RawRow[]; error?: string } {
  if (!text.trim()) return { rows: [], error: "The CSV file is empty." };

  let records: Record<string, string>[];
  try {
    records = parse(text, {
      bom: true,
      trim: true,
      skip_empty_lines: true,
      relax_column_count: true,
      columns: (header: string[]) => header.map((h) => HEADER_MAP[normalizeHeader(h)] ?? normalizeHeader(h)),
    });
  } catch {
    return { rows: [], error: "Could not parse the CSV file. Check the format and try again." };
  }

  if (records.length === 0) return { rows: [], error: "The CSV has no data rows." };

  const present = new Set(Object.keys(records[0]));
  const missing = (["make", "model", "serialNumber"] as const).filter((k) => !present.has(k));
  if (missing.length) return { rows: [], error: `Missing required column(s): ${missing.join(", ")}.` };

  if (records.length > MAX_IMPORT_ROWS) {
    return { rows: [], error: `Too many rows (${records.length}). The limit is ${MAX_IMPORT_ROWS} per import.` };
  }

  const rows = records.map((r, i) => ({
    row: i + 1,
    make: r.make ?? "",
    model: r.model ?? "",
    serialNumber: r.serialNumber ?? "",
    homeUnit: r.homeUnit ?? "",
    notes: r.notes ?? "",
  }));
  return { rows };
}
