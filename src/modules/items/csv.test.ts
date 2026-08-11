import { describe, it, expect } from "vitest";
import { parseItemsCsv, MAX_IMPORT_ROWS } from "./csv";

describe("parseItemsCsv", () => {
  it("parses rows and maps case-insensitive, aliased headers", () => {
    const csv = "Make,Model,Serial Number,Device Name,Home Unit,Notes\nM4,Carbine,A1,Radio,A Co,tan\n";
    const { rows, error } = parseItemsCsv(csv);
    expect(error).toBeUndefined();
    expect(rows[0]).toMatchObject({
      row: 1, make: "M4", model: "Carbine", serialNumber: "A1", deviceName: "Radio", homeUnit: "A Co", notes: "tan",
      assignedUser: "", lastLogonUserPrincipalName: "", lastLogonDate: "", enrollmentDate: "", compliance: "",
    });
  });

  it("maps the fleet export's DeviceOwnershipUIC column to the UIC", () => {
    // The real MDM export names it this. It previously fell through as an
    // unknown header, so a 1,000-row import reported success while leaving
    // every UIC empty.
    const csv = 'SerialNumber,DeviceOwnershipUIC\nA1,W6BTAA\n';
    const { rows, error } = parseItemsCsv(csv);
    expect(error).toBeUndefined();
    expect(rows[0].deviceUIC).toBe("W6BTAA");
  });

  it("accepts every UIC header spelling", () => {
    for (const header of ["UIC", "deviceUIC", "DeviceOwnershipUIC", "Device Ownership UIC", "OwnershipUIC"]) {
      const { rows, error } = parseItemsCsv(`SerialNumber,${header}\nA1,W6BTAA\n`);
      expect(error, header).toBeUndefined();
      expect(rows[0].deviceUIC, header).toBe("W6BTAA");
    }
  });

  it("fills the device category from a deviceType column", () => {
    const csv = "SerialNumber,deviceType\nA1,Laptop\nA2,Switch\n";
    const { rows, error } = parseItemsCsv(csv);
    expect(error).toBeUndefined();
    expect(rows.map((r) => r.deviceCategory)).toEqual(["Laptop", "Switch"]);
  });

  it("accepts deviceType in any spacing/casing, alongside the other category aliases", () => {
    for (const header of ["deviceType", "Device Type", "DEVICE_TYPE", "deviceCategory", "Category"]) {
      const { rows, error } = parseItemsCsv(`SerialNumber,${header}\nA1,Laptop\n`);
      expect(error, header).toBeUndefined();
      expect(rows[0].deviceCategory, header).toBe("Laptop");
    }
  });

  it("still IGNORES a bare `type` column", () => {
    // MDM exports carry a generic "Type" column of OS strings. Mapping it to
    // the category would overwrite every matched item's category on import, so
    // it must stay unrecognised — deviceType is the explicit opt-in.
    const csv = "SerialNumber,Type\nA1,Windows 11 Pro 23H2\n";
    const { rows, error } = parseItemsCsv(csv);
    expect(error).toBeUndefined();
    expect(rows[0].deviceCategory).toBe("");
  });

  it("prefers nothing when deviceType is blank, leaving the stored value untouched", () => {
    const { rows } = parseItemsCsv("SerialNumber,deviceType\nA1,\n");
    expect(rows[0].deviceCategory).toBe("");
  });

  it("maps the new assignedUser + telemetry headers in any column order and any case", () => {
    const csv =
      "SerialNumber,Compliance,Assigned User,LASTLOGONDATE,lastLogonUserPrincipalName,EnrollmentDate\n" +
      "A1,Compliant,jane@x.mil,2026-07-01,jane@x.mil,2025-01-15\n";
    const { rows, error } = parseItemsCsv(csv);
    expect(error).toBeUndefined();
    expect(rows[0]).toMatchObject({
      serialNumber: "A1", compliance: "Compliant", assignedUser: "jane@x.mil",
      lastLogonDate: "2026-07-01", lastLogonUserPrincipalName: "jane@x.mil", enrollmentDate: "2025-01-15",
    });
  });

  it("requires only the serialNumber column (make/model/deviceName optional)", () => {
    const { rows, error } = parseItemsCsv("serialNumber,compliance\nA1,Compliant\n");
    expect(error).toBeUndefined();
    expect(rows[0]).toMatchObject({ serialNumber: "A1", make: "", model: "", deviceName: "" });
  });

  it("handles quoted fields with embedded commas and skips blank lines", () => {
    const csv = 'make,model,serialNumber,deviceName,notes\nM4,Carbine,A1,Radio,"tan, worn"\n\nPVS,14,B7,Radio,\n';
    const { rows } = parseItemsCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0].notes).toBe("tan, worn");
    expect(rows[1]).toMatchObject({ row: 2, make: "PVS", serialNumber: "B7", notes: "" });
  });

  it("errors when the serialNumber column is missing", () => {
    const { error } = parseItemsCsv("make,model\nM4,Carbine\n");
    expect(error).toMatch(/serialNumber/);
  });

  it("errors on an empty file", () => {
    expect(parseItemsCsv("   ").error).toMatch(/empty/i);
  });

  it("errors when there are no data rows", () => {
    expect(parseItemsCsv("make,model,serialNumber\n").error).toMatch(/no data/i);
  });

  it("errors when over the row cap", () => {
    const body = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `M,N,S${i},Radio`).join("\n");
    const { error } = parseItemsCsv(`make,model,serialNumber,deviceName\n${body}\n`);
    expect(error).toMatch(/limit/i);
  });

  it("errors (does not throw) on unparseable CSV", () => {
    const { rows, error } = parseItemsCsv('make,model,serialNumber\n"A,B,C\n');
    expect(rows).toHaveLength(0);
    expect(error).toMatch(/could not parse|format/i);
  });

  it("does not falsely reject when the first data row is ragged", () => {
    // Header has all 4 required columns; first data row is short (missing deviceName cell).
    const { rows, error } = parseItemsCsv("make,model,serialNumber,deviceName\nA,B,C\nC,D,E,Radio\n");
    expect(error).toBeUndefined();
    expect(rows).toHaveLength(2);
    expect(rows[0].deviceName).toBe(""); // ragged cell becomes empty, later skipped by validation downstream
  });
});

describe("parseItemsCsv header aliasing", () => {
  it("maps every accepted spelling of the storage-location column", () => {
    for (const header of ["sloc", "SLoc", "S_Loc", "S Loc", "storageLocation", "Storage Location", "storageloc"]) {
      const { rows, error } = parseItemsCsv(`serialNumber,${header}\nABC123,Bldg 400 Cage 3\n`);
      expect(error, `header "${header}" failed to parse`).toBeUndefined();
      expect(rows[0]?.storageLocation, `header "${header}" did not map`).toBe("Bldg 400 Cage 3");
    }
  });

  it("IGNORES a bare `location` header", () => {
    // Deliberate: a fleet or MDM export can carry a generic "Location" column
    // meaning a geographic site. Aliasing it would overwrite every matched
    // device's storage location in one import and log that churn to history.
    const { rows, error } = parseItemsCsv("serialNumber,location\nABC123,Germany\n");
    expect(error).toBeUndefined();
    expect(rows[0]?.storageLocation).toBe("");
  });

  it("leaves storageLocation blank when the column is absent", () => {
    const { rows } = parseItemsCsv("serialNumber,make\nABC123,Dell\n");
    expect(rows[0]?.storageLocation).toBe("");
  });

  it("maps every accepted spelling of the last-sync column", () => {
    for (const header of ["lastSync", "LastSync", "Last Sync", "last_sync", "Last-Sync", "lastSyncDateTime", "Last Sync Date Time", "lastSyncDate"]) {
      const { rows, error } = parseItemsCsv(`serialNumber,${header}\nABC123,8/9/2026 6:02:11 AM\n`);
      expect(error, `header "${header}" failed to parse`).toBeUndefined();
      expect(rows[0]?.lastSyncDateTime, `header "${header}" did not map`).toBe("8/9/2026 6:02:11 AM");
    }
  });

  it("IGNORES a bare `sync` header", () => {
    // Deliberate, like the bare `type` and `location` cases above: `Sync` is a
    // generic word an MDM export can spend on a sync STATUS rather than a
    // timestamp, and aliasing it would fill the column with the wrong kind of
    // value on every matched device.
    const { rows, error } = parseItemsCsv("serialNumber,sync\nABC123,Succeeded\n");
    expect(error).toBeUndefined();
    expect(rows[0]?.lastSyncDateTime).toBe("");
  });

  it("keeps last sync and last logon separate when both columns are present", () => {
    // The whole point of the field: they answer different questions, so a CSV
    // carrying both must not let one overwrite the other.
    const { rows } = parseItemsCsv(
      "serialNumber,lastLogonDate,lastSync\nABC123,7/25/2026 1:40:21 AM,8/9/2026 6:02:11 AM\n",
    );
    expect(rows[0]?.lastLogonDate).toBe("7/25/2026 1:40:21 AM");
    expect(rows[0]?.lastSyncDateTime).toBe("8/9/2026 6:02:11 AM");
  });

  it("leaves lastSyncDateTime blank when the column is absent", () => {
    const { rows } = parseItemsCsv("serialNumber,make\nABC123,Dell\n");
    expect(rows[0]?.lastSyncDateTime).toBe("");
  });
});
