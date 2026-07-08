import { describe, it, expect } from "vitest";
import { parseItemsCsv, MAX_IMPORT_ROWS } from "./csv";

describe("parseItemsCsv", () => {
  it("parses rows and maps case-insensitive, aliased headers", () => {
    const csv = "Make,Model,Serial Number,Home Unit,Notes\nM4,Carbine,A1,A Co,tan\n";
    const { rows, error } = parseItemsCsv(csv);
    expect(error).toBeUndefined();
    expect(rows).toEqual([
      { row: 1, make: "M4", model: "Carbine", serialNumber: "A1", homeUnit: "A Co", notes: "tan" },
    ]);
  });

  it("handles quoted fields with embedded commas and skips blank lines", () => {
    const csv = 'make,model,serialNumber,notes\nM4,Carbine,A1,"tan, worn"\n\nPVS,14,B7,\n';
    const { rows } = parseItemsCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0].notes).toBe("tan, worn");
    expect(rows[1]).toMatchObject({ row: 2, make: "PVS", serialNumber: "B7", notes: "" });
  });

  it("errors when a required header is missing", () => {
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
    const body = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `M,N,S${i}`).join("\n");
    const { error } = parseItemsCsv(`make,model,serialNumber\n${body}\n`);
    expect(error).toMatch(/limit/i);
  });
});
