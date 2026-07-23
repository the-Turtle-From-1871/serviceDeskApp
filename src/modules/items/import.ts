import { importRowSchema } from "./items.schema";
import type { RawRow } from "./csv";
import { detectHomeUnit, splitSegments } from "./unit-detect";
import { diffItemFields, type FieldChange, type ItemLoggedFields } from "./item-diff";

export type SkippedRow = { row: number; serialNumber: string; reason: string };
export type UnresolvedRow = { row: number; deviceName: string; segments: string[] };

// The columns of an existing item needed to match a CSV row and diff it. Fetched
// in one findMany by the caller and keyed by lowercased serial (citext identity).
export type ExistingItem = {
  id: string;
  make: string;
  model: string;
  deviceName: string | null;
  currentUserEmail: string | null;
  lastLogonUserPrincipalName: string | null;
  lastLogonDate: string | null;
  enrollmentDate: string | null;
  compliance: string | null;
};

// A row that will create a new item. make/model are required for creates (checked
// below); the rest are set only when the CSV provided a value.
export type NewItemImport = {
  make: string;
  model: string;
  serialNumber: string;
  deviceName?: string;
  homeUnit?: string;
  notes?: string;
  currentUserEmail?: string;
  lastLogonUserPrincipalName?: string;
  lastLogonDate?: string;
  enrollmentDate?: string;
  compliance?: string;
};

// A row that matched an existing serial and has at least one changed field.
// `data` is the exact column set to write; `loggedChanges` is the subset
// (deviceName/currentUserEmail) recorded to ItemEdit — telemetry updates silently.
export type ItemUpdate = {
  row: number;
  itemId: string;
  serialNumber: string;
  data: Record<string, string | null>;
  loggedChanges: FieldChange[];
  makeModelMismatch: boolean;
};

export type UnchangedRow = { row: number; serialNumber: string; makeModelMismatch: boolean };

export type PlanResult = {
  toCreate: NewItemImport[];
  toUpdate: ItemUpdate[];
  unchanged: UnchangedRow[];
  skipped: SkippedRow[];
  unresolved: UnresolvedRow[];
  detected: number;
};

// Pure planning: validate each row (serial required), dedup within the file
// (first occurrence wins), then either UPDATE a matching existing item's changed
// tracked fields, mark it unchanged, or CREATE a new item (make/model required).
// Only when homeUnit is blank on a create is it derived from the device name.
export function planImport(
  rows: RawRow[],
  // Keyed by LOWERCASED serial by the caller — matching is case-insensitive (citext).
  existingBySerial: Map<string, ExistingItem>,
  unitsByAbbrev: Map<string, string>,
): PlanResult {
  const toCreate: NewItemImport[] = [];
  const toUpdate: ItemUpdate[] = [];
  const unchanged: UnchangedRow[] = [];
  const skipped: SkippedRow[] = [];
  const unresolved: UnresolvedRow[] = [];
  const seen = new Set<string>();
  let detected = 0;

  for (const r of rows) {
    const parsed = importRowSchema.safeParse({
      make: r.make,
      model: r.model,
      serialNumber: r.serialNumber,
      deviceName: r.deviceName,
      homeUnit: r.homeUnit,
      notes: r.notes,
      assignedUser: r.assignedUser,
      lastLogonUserPrincipalName: r.lastLogonUserPrincipalName,
      lastLogonDate: r.lastLogonDate,
      enrollmentDate: r.enrollmentDate,
      compliance: r.compliance,
    });
    if (!parsed.success) {
      skipped.push({ row: r.row, serialNumber: r.serialNumber, reason: parsed.error.issues[0]?.message ?? "invalid row" });
      continue;
    }
    const d = parsed.data;
    const sn = d.serialNumber;
    const snKey = sn.toLowerCase();

    if (seen.has(snKey)) {
      skipped.push({ row: r.row, serialNumber: sn, reason: "duplicate in file" });
      continue;
    }
    seen.add(snKey);

    const match = existingBySerial.get(snKey);
    if (match) {
      // UPDATE / UNCHANGED path. make/model are never overwritten — only flagged.
      const makeModelMismatch = diffItemFields(match, {
        ...(d.make !== undefined ? { make: d.make } : {}),
        ...(d.model !== undefined ? { model: d.model } : {}),
      }).length > 0;

      // Logged fields (deviceName, currentUserEmail) -> ItemEdit history.
      const loggedAfter: Partial<ItemLoggedFields> = {};
      if (d.deviceName !== undefined) loggedAfter.deviceName = d.deviceName;
      if (d.assignedUser !== undefined) loggedAfter.currentUserEmail = d.assignedUser;
      const loggedChanges = diffItemFields(match, loggedAfter);

      // Silent telemetry fields -> updated but not logged.
      const silentAfter: Partial<ItemLoggedFields> = {};
      if (d.lastLogonUserPrincipalName !== undefined) silentAfter.lastLogonUserPrincipalName = d.lastLogonUserPrincipalName;
      if (d.lastLogonDate !== undefined) silentAfter.lastLogonDate = d.lastLogonDate;
      if (d.enrollmentDate !== undefined) silentAfter.enrollmentDate = d.enrollmentDate;
      if (d.compliance !== undefined) silentAfter.compliance = d.compliance;
      const silentChanges = diffItemFields(match, silentAfter);

      const allChanges = [...loggedChanges, ...silentChanges];
      if (allChanges.length === 0) {
        unchanged.push({ row: r.row, serialNumber: sn, makeModelMismatch });
        continue;
      }
      const data: Record<string, string | null> = {};
      for (const c of allChanges) data[c.field] = c.to;
      toUpdate.push({ row: r.row, itemId: match.id, serialNumber: sn, data, loggedChanges, makeModelMismatch });
      continue;
    }

    // CREATE path — make and model are required for a new item.
    if (!d.make || !d.model) {
      skipped.push({ row: r.row, serialNumber: sn, reason: "make and model are required for new items" });
      continue;
    }
    const item: NewItemImport = {
      make: d.make,
      model: d.model,
      serialNumber: sn,
      deviceName: d.deviceName,
      homeUnit: d.homeUnit,
      notes: d.notes,
      currentUserEmail: d.assignedUser,
      lastLogonUserPrincipalName: d.lastLogonUserPrincipalName,
      lastLogonDate: d.lastLogonDate,
      enrollmentDate: d.enrollmentDate,
      compliance: d.compliance,
    };
    if (!item.homeUnit && item.deviceName) {
      const full = detectHomeUnit(item.deviceName, unitsByAbbrev);
      if (full) {
        item.homeUnit = full;
        detected++;
      } else {
        unresolved.push({ row: r.row, deviceName: item.deviceName, segments: splitSegments(item.deviceName) });
      }
    }
    toCreate.push(item);
  }

  return { toCreate, toUpdate, unchanged, skipped, unresolved, detected };
}
