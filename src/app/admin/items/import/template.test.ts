import { describe, it, expect } from "vitest";
import { TEMPLATE } from "./ImportItemsForm";
import { parseItemsCsv } from "@/modules/items/csv";

/**
 * The downloadable starter CSV is the first thing a new admin uses, and it is a
 * hand-maintained string sitting far away from the parser that reads it. These
 * tests round-trip the ACTUAL bytes the user downloads through the ACTUAL
 * importer, so a column renamed in one place and not the other fails here
 * rather than silently shipping a template that imports nothing.
 */
describe("import CSV template", () => {
  const { rows, error } = parseItemsCsv(TEMPLATE);

  it("parses without error", () => {
    expect(error).toBeUndefined();
  });

  it("contains one example row", () => {
    expect(rows).toHaveLength(1);
  });

  it("populates every column it advertises", () => {
    // `notes` is intentionally blank in the example (it is free text with no
    // meaningful sample); everything else must demonstrate a real value.
    const r = rows[0];
    const populated = {
      make: r.make,
      model: r.model,
      serialNumber: r.serialNumber,
      deviceName: r.deviceName,
      deviceCategory: r.deviceCategory,
      homeUnit: r.homeUnit,
      deviceUIC: r.deviceUIC,
      assignedUser: r.assignedUser,
      lastLogonUserPrincipalName: r.lastLogonUserPrincipalName,
      lastLogonDate: r.lastLogonDate,
      enrollmentDate: r.enrollmentDate,
      compliance: r.compliance,
    };
    const blank = Object.entries(populated).filter(([, v]) => !v || v.trim() === "");
    expect(blank.map(([k]) => k)).toEqual([]);
  });

  it("maps deviceType to the device category", () => {
    // The template advertises `deviceType`; if that alias were ever dropped the
    // header would parse as an unknown column and silently import nothing.
    expect(rows[0].deviceCategory).toBe("Laptop");
  });

  it("carries a lastLogonDate the readiness parser understands", async () => {
    // Readiness compares the parsed instant to markedReadyAt. A template whose
    // example date does not parse would teach the wrong format.
    const { parseLastLogonAt } = await import("@/modules/items/readiness");
    expect(parseLastLogonAt(rows[0].lastLogonDate)).toBeInstanceOf(Date);
  });

  it("lists serialNumber, the only required column", () => {
    expect(TEMPLATE.split("\n")[0]).toContain("serialNumber");
  });
});
