import { parse } from "csv-parse/sync";

export const MAX_IMPORT_ROWS = 2000;

export type RawRow = {
  row: number;
  make: string;
  model: string;
  serialNumber: string;
  deviceName: string;
  homeUnit: string;
  deviceUIC: string;
  deviceCategory: string;
  notes: string;
  assignedUser: string;
  lastLogonUserPrincipalName: string;
  lastLogonDate: string;
  enrollmentDate: string;
  compliance: string;
};

// Map a normalized (lowercased, alphanumeric-only) header to a canonical field.
const HEADER_MAP: Record<string, keyof Omit<RawRow, "row">> = {
  make: "make",
  model: "model",
  serialnumber: "serialNumber",
  serial: "serialNumber",
  devicename: "deviceName",
  homeunit: "homeUnit",
  deviceuic: "deviceUIC",
  uic: "deviceUIC",
  // Only EXPLICIT category headers map here. `type`/`devicetype` were tried and
  // removed: MDM exports routinely carry a "Type" column holding OS strings
  // ("Windows 11 Pro 23H2"), which previously fell through as an unknown header
  // and was ignored. Aliasing it would overwrite every matched item's category
  // with an OS string, log that to ItemEdit history, and pollute the managed
  // vocabulary. Do not re-add a generic alias.
  devicecategory: "deviceCategory",
  category: "deviceCategory",
  notes: "notes",
  assigneduser: "assignedUser",
  lastlogonuserprincipalname: "lastLogonUserPrincipalName",
  lastlogondate: "lastLogonDate",
  enrollmentdate: "enrollmentDate",
  compliance: "compliance",
};

const normalizeHeader = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

export function parseItemsCsv(text: string): { rows: RawRow[]; error?: string } {
  if (!text.trim()) return { rows: [], error: "The CSV file is empty." };

  let records: Record<string, string>[];
  let headers: string[] = [];
  try {
    records = parse(text, {
      bom: true,
      trim: true,
      skip_empty_lines: true,
      relax_column_count: true,
      columns: (header: string[]) =>
        (headers = header.map((h) => HEADER_MAP[normalizeHeader(h)] ?? normalizeHeader(h))),
    });
  } catch {
    return { rows: [], error: "Could not parse the CSV file. Check the format and try again." };
  }

  if (records.length === 0) return { rows: [], error: "The CSV has no data rows." };

  const present = new Set(headers);
  const missing = (["serialNumber"] as const).filter((k) => !present.has(k));
  if (missing.length) return { rows: [], error: `Missing required column(s): ${missing.join(", ")}.` };

  if (records.length > MAX_IMPORT_ROWS) {
    return { rows: [], error: `Too many rows (${records.length}). The limit is ${MAX_IMPORT_ROWS} per import.` };
  }

  const rows = records.map((r, i) => ({
    row: i + 1,
    make: r.make ?? "",
    model: r.model ?? "",
    serialNumber: r.serialNumber ?? "",
    deviceName: r.deviceName ?? "",
    homeUnit: r.homeUnit ?? "",
    deviceUIC: r.deviceUIC ?? "",
    deviceCategory: r.deviceCategory ?? "",
    notes: r.notes ?? "",
    assignedUser: r.assignedUser ?? "",
    lastLogonUserPrincipalName: r.lastLogonUserPrincipalName ?? "",
    lastLogonDate: r.lastLogonDate ?? "",
    enrollmentDate: r.enrollmentDate ?? "",
    compliance: r.compliance ?? "",
  }));
  return { rows };
}
