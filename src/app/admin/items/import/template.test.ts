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
      // The template has carried a lastSync example since the column shipped,
      // but this list did not — so dropping the value would have failed
      // nothing. It matters more than the others: prod carries the header on
      // zero rows today, and the dormant-device list is empty until an export
      // supplies it, so the template is the one place that teaches the format.
      lastSyncDateTime: r.lastSyncDateTime,
    };
    const blank = Object.entries(populated).filter(([, v]) => !v || v.trim() === "");
    expect(blank.map(([k]) => k)).toEqual([]);
  });

  it("maps deviceType to the device category", () => {
    // The template advertises `deviceType`; if that alias were ever dropped the
    // header would parse as an unknown column and silently import nothing.
    expect(rows[0].deviceCategory).toBe("Laptop");
  });

  it("carries dates the MDM parser understands", async () => {
    // Both columns have a parsed twin written on import, and a template whose
    // example does not parse teaches the wrong format. lastSync is the one that
    // would fail quietly: an unparseable value still stores its raw text and
    // still renders on the item page, so the only visible symptom would be the
    // device never reaching the dormant-device list.
    const { parseMdmDateTime } = await import("@/modules/items/readiness");
    expect(parseMdmDateTime(rows[0].lastLogonDate)).toBeInstanceOf(Date);
    expect(parseMdmDateTime(rows[0].lastSyncDateTime)).toBeInstanceOf(Date);
  });

  it("maps the lastSync header the export actually uses", () => {
    // The template advertises `lastSync`, which is the fleet export's own
    // spelling. If that alias were dropped the header would parse as an unknown
    // column and import nothing — the failure that leaves the dormant-device
    // list permanently empty while every import reports success.
    expect(TEMPLATE.split("\n")[0]).toContain("lastSync");
    expect(rows[0].lastSyncDateTime).toBe("8/9/2026 6:02:11 AM");
  });

  it("lists serialNumber, the only required column", () => {
    expect(TEMPLATE.split("\n")[0]).toContain("serialNumber");
  });
});
