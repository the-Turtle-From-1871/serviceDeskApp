import { describe, it, expect } from "vitest";
import { parseItemsCsv, MAX_IMPORT_ROWS } from "./csv";

describe("parseItemsCsv", () => {
  it("parses rows and maps case-insensitive, aliased headers", () => {
    const csv = "Make,Model,Serial Number,Device Name,Home Unit,Notes\nM4,Carbine,A1,Radio,A Co,tan\n";
    const { rows, error } = parseItemsCsv(csv);
    expect(error).toBeUndefined();
    expect(rows).toEqual([
      { row: 1, make: "M4", model: "Carbine", serialNumber: "A1", deviceName: "Radio", homeUnit: "A Co", notes: "tan" },
    ]);
  });

  it("handles quoted fields with embedded commas and skips blank lines", () => {
    const csv = 'make,model,serialNumber,deviceName,notes\nM4,Carbine,A1,Radio,"tan, worn"\n\nPVS,14,B7,Radio,\n';
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
