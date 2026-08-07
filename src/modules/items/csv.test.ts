import { describe, it, expect } from "vitest";
import { parseItemsCsv } from "./csv";

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
});
