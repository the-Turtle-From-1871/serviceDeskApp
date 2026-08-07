import { importRowSchema } from "./items.schema";
import type { RawRow } from "./csv";
import { detectHomeUnit, splitSegments } from "./unit-detect";
import { diffItemFields, type FieldChange, type ItemLoggedFields } from "./item-diff";
import { parseLastLogonAt } from "./readiness";

export type SkippedRow = { row: number; serialNumber: string; reason: string };
export type UnresolvedRow = { row: number; deviceName: string; segments: string[] };

// The columns of an existing item needed to match a CSV row and diff it. Fetched
// in one findMany by the caller and keyed by lowercased serial (citext identity).
export type ExistingItem = {
  id: string;
  // "ACTIVE" | "RETIRED". Retired items still update, but we never write an
  // ItemEdit history row for them (an MDM refresh shouldn't add churn to the
  // audit trail of an out-of-service device).
  status: string;
  make: string;
  model: string;
  deviceName: string | null;
  homeUnit: string | null;
  deviceUIC: string | null;
  deviceCategory: string | null;
  storageLocation: string | null;
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
  deviceUIC?: string;
  deviceCategory?: string;
  storageLocation?: string;
  notes?: string;
  currentUserEmail?: string;
  lastLogonUserPrincipalName?: string;
  lastLogonDate?: string;
  /** Derived from lastLogonDate at plan time; see readiness.ts. */
  lastLogonAt?: Date;
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
  // `string | Date` because the derived `lastLogonAt` instant travels
  // alongside the raw `lastLogonDate` text it is parsed from.
  data: Record<string, string | Date | null>;
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
      deviceUIC: r.deviceUIC,
      deviceCategory: r.deviceCategory,
      storageLocation: r.storageLocation,
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

      // The value deviceName WILL have after this import — the CSV's own value
      // when it supplied one, else whatever is already stored. Used below so a
      // row that gains a decodable name in this SAME import can still resolve
      // its home unit, mirroring the CREATE branch's use of item.deviceName.
      const effectiveDeviceName = d.deviceName !== undefined ? d.deviceName : match.deviceName;

      // Set when this row's homeUnit came from detectHomeUnit below (as opposed
      // to a CSV-supplied value). Whether it counts toward `detected` is decided
      // AFTER diffItemFields runs, by checking loggedChanges for an actual
      // homeUnit change — see below.
      let homeUnitDerivedByDetection = false;

      // Logged fields (deviceName, deviceUIC, currentUserEmail) -> ItemEdit history.
      const loggedAfter: Partial<ItemLoggedFields> = {};
      if (d.deviceName !== undefined) loggedAfter.deviceName = d.deviceName;
      if (d.deviceUIC !== undefined) loggedAfter.deviceUIC = d.deviceUIC;
      if (d.deviceCategory !== undefined) loggedAfter.deviceCategory = d.deviceCategory;
      if (d.storageLocation !== undefined) loggedAfter.storageLocation = d.storageLocation;
      if (d.assignedUser !== undefined) loggedAfter.currentUserEmail = d.assignedUser;

      // homeUnit: the CSV import is the single source of truth (task 8). A row
      // that already exists gets it the SAME way a freshly created row does —
      // see the mirrored logic in the CREATE branch below — and that means a
      // CSV-supplied value OVERWRITES whatever is already stored, exactly like
      // deviceName/deviceUIC/deviceCategory/currentUserEmail above. Do not add
      // a "only if blank" guard here.
      if (d.homeUnit !== undefined) {
        // Verbatim, no normalisation/canonicalisation against the Unit
        // vocabulary — whatever the export says is what the item holds. Not
        // an auto-detection, so `detected` is untouched.
        loggedAfter.homeUnit = d.homeUnit;
      } else if (effectiveDeviceName) {
        const full = detectHomeUnit(effectiveDeviceName, unitsByAbbrev);
        if (full) {
          loggedAfter.homeUnit = full;
          homeUnitDerivedByDetection = true;
        } else if (!match.homeUnit) {
          // Still blank after both sources (no CSV value, detection failed)
          // AND there was a name to try decoding: report it the same way the
          // CREATE branch does, for the admin panel to surface. A row that
          // already carries a home unit is not "unresolved" — it just isn't
          // being changed this import, per the "leave it alone" rule above.
          unresolved.push({ row: r.row, deviceName: effectiveDeviceName, segments: splitSegments(effectiveDeviceName) });
        }
      }
      // Otherwise (no CSV value, no effective device name): leave it alone —
      // homeUnit is simply absent from loggedAfter, so diffItemFields treats
      // it as "not submitted" and the stored value is untouched.
      const loggedChanges = diffItemFields(match, loggedAfter);

      // `detected` counts devices whose home unit this import actually filled
      // in or corrected — not devices whose name merely still decodes to the
      // value they already hold. Reuse diffItemFields' own normalisation
      // (trim, blank->null) rather than hand-rolling a second comparison here:
      // only increment when the detected value produced a REAL homeUnit entry
      // in loggedChanges, i.e. it differs from what's already stored.
      if (homeUnitDerivedByDetection && loggedChanges.some((c) => c.field === "homeUnit")) {
        detected++;
      }

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
      const data: Record<string, string | Date | null> = {};
      for (const c of allChanges) data[c.field] = c.to;
      // Keep the parsed instant in step with the raw text. Readiness no longer
      // compares lastLogonAt to markedReadyAt (that rule was removed), but the
      // column still backs analytics and is what a reinstated rule would read —
      // so a refreshed lastLogonDate whose lastLogonAt went stale would leave
      // the two disagreeing about the same device.
      if (data.lastLogonDate !== undefined) {
        data.lastLogonAt = parseLastLogonAt(data.lastLogonDate as string | null);
      }
      // Retired items still get their fields updated (data holds every change),
      // but emit no loggedChanges so commitImport writes no ItemEdit for them.
      const emittedLogged = match.status === "RETIRED" ? [] : loggedChanges;
      toUpdate.push({ row: r.row, itemId: match.id, serialNumber: sn, data, loggedChanges: emittedLogged, makeModelMismatch });
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
      deviceUIC: d.deviceUIC,
      deviceCategory: d.deviceCategory,
      storageLocation: d.storageLocation,
      notes: d.notes,
      currentUserEmail: d.assignedUser,
      lastLogonUserPrincipalName: d.lastLogonUserPrincipalName,
      lastLogonDate: d.lastLogonDate,
      lastLogonAt: parseLastLogonAt(d.lastLogonDate) ?? undefined,
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
