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
  storageLocation: string;
  notes: string;
  assignedUser: string;
  lastLogonUserPrincipalName: string;
  lastLogonDate: string;
  enrollmentDate: string;
  compliance: string;
  lastSyncDateTime: string;
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
  // The MDM fleet export's own name for it. Without this the column falls
  // through as an unknown header and is silently ignored — a full import then
  // reports success while leaving every UIC empty.
  deviceownershipuic: "deviceUIC",
  ownershipuic: "deviceUIC",
  // Category headers. `deviceType` is the column the fleet export carries
  // ("Laptop", "Switch"), and it fills the device category.
  //
  // NOTE the deliberate absence of a bare `type` alias. MDM exports routinely
  // include a generic "Type" column holding OS strings ("Windows 11 Pro
  // 23H2"); today that header is unrecognised and ignored, which is the safe
  // outcome. Aliasing it would overwrite every matched item's category with an
  // OS string, log that churn to ItemEdit history, and pollute the managed
  // category vocabulary. Keep the alias list explicit.
  devicecategory: "deviceCategory",
  devicetype: "deviceCategory",
  category: "deviceCategory",
  // Storage location — the fleet export's "SLoc". normalizeHeader strips case
  // and non-alphanumerics, so "SLoc", "S_Loc", "S Loc" and "Storage Location"
  // all arrive here as one of these three keys.
  //
  // NOTE the deliberate absence of a bare `location` alias, for the same reason
  // a bare `type` is absent above: an MDM or fleet export can carry a generic
  // "Location" column holding a geographic site or building, and aliasing it
  // would overwrite every matched device's storage location in a single import
  // and log that churn to ItemEdit history. Keep the alias list explicit.
  sloc: "storageLocation",
  storagelocation: "storageLocation",
  storageloc: "storageLocation",
  notes: "notes",
  assigneduser: "assignedUser",
  lastlogonuserprincipalname: "lastLogonUserPrincipalName",
  lastlogondate: "lastLogonDate",
  enrollmentdate: "enrollmentDate",
  compliance: "compliance",
  // When MDM last checked in with the device — NOT when a person last signed
  // in (that is lastLogonDate above). The export's own header is "LastSync";
  // normalizeHeader strips case and punctuation, so "Last Sync", "last_sync"
  // and "Last-Sync" all arrive here too, and the two longer spellings cover an
  // export that names the column more fully.
  //
  // NOTE the deliberate absence of a bare `sync`, for the same reason a bare
  // `type` and a bare `location` are absent above: it is a generic word an MDM
  // export can spend on a sync STATUS ("Succeeded", "Pending") rather than a
  // timestamp, and aliasing it would fill this column with the wrong kind of
  // value on every matched device. Keep the alias list explicit.
  lastsync: "lastSyncDateTime",
  lastsyncdatetime: "lastSyncDateTime",
  lastsyncdate: "lastSyncDateTime",
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
    storageLocation: r.storageLocation ?? "",
    notes: r.notes ?? "",
    assignedUser: r.assignedUser ?? "",
    lastLogonUserPrincipalName: r.lastLogonUserPrincipalName ?? "",
    lastLogonDate: r.lastLogonDate ?? "",
    enrollmentDate: r.enrollmentDate ?? "",
    compliance: r.compliance ?? "",
    lastSyncDateTime: r.lastSyncDateTime ?? "",
  }));
  return { rows };
}
