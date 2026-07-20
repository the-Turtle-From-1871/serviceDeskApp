import { describe, it, expect } from "vitest";
import { planImport } from "./import";
import type { RawRow } from "./csv";

const UNITS = new Map<string, string>([["DCSIM", "DCSIM"], ["487B", "487FA BATTERY B"]]);

const mk = (row: number, over: Partial<RawRow> = {}): RawRow =>
  ({ row, make: "M4", model: "Carbine", serialNumber: `S${row}`, deviceName: "Radio", homeUnit: "", notes: "", ...over });

describe("planImport", () => {
  it("keeps valid, non-duplicate rows", () => {
    const { toCreate, skipped } = planImport([mk(1), mk(2)], new Set(), UNITS);
    expect(toCreate).toHaveLength(2);
    expect(skipped).toHaveLength(0);
    expect(toCreate[0]).toMatchObject({ make: "M4", model: "Carbine", serialNumber: "S1" });
  });

  it("skips a row whose serial already exists in the DB (case-insensitive; existing set is lowercased)", () => {
    // Incoming "A1" matches the lowercased existing "a1" — proves the citext-aligned
    // case-insensitive dedup.
    const { toCreate, skipped } = planImport([mk(1, { serialNumber: "A1" })], new Set(["a1"]), UNITS);
    expect(toCreate).toHaveLength(0);
    expect(skipped).toEqual([{ row: 1, serialNumber: "A1", reason: "already exists" }]);
  });

  it("treats serials differing only in case as the same device within a file", () => {
    const { toCreate, skipped } = planImport(
      [mk(1, { serialNumber: "AbC123" }), mk(2, { serialNumber: "abc123" })],
      new Set(),
      UNITS,
    );
    expect(toCreate).toHaveLength(1);
    expect(toCreate[0].serialNumber).toBe("AbC123"); // first wins, original casing preserved
    expect(skipped).toEqual([{ row: 2, serialNumber: "abc123", reason: "duplicate in file" }]);
  });

  it("keeps the first and skips later duplicates within the file", () => {
    const { toCreate, skipped } = planImport(
      [mk(1, { serialNumber: "D1" }), mk(2, { serialNumber: "D1" })],
      new Set(),
      UNITS,
    );
    expect(toCreate).toHaveLength(1);
    expect(skipped).toEqual([{ row: 2, serialNumber: "D1", reason: "duplicate in file" }]);
  });

  it("skips an invalid row with the validation message", () => {
    const { toCreate, skipped } = planImport([mk(1, { model: "" })], new Set(), UNITS);
    expect(toCreate).toHaveLength(0);
    expect(skipped[0]).toMatchObject({ row: 1, reason: "Model is required" });
  });

  it("skips a row with a blank device name", () => {
    const { toCreate, skipped } = planImport([mk(1, { deviceName: "" })], new Set(), UNITS);
    expect(toCreate).toHaveLength(0);
    expect(skipped[0].reason).toMatch(/device name/i);
  });

  it("auto-fills homeUnit from the device name when blank", () => {
    const { toCreate, detected, unresolved } = planImport(
      [mk(1, { deviceName: "HI-DCSIM-LT-001", homeUnit: "" })],
      new Set(),
      UNITS,
    );
    expect(toCreate[0].homeUnit).toBe("DCSIM");
    expect(detected).toBe(1);
    expect(unresolved).toHaveLength(0);
  });

  it("preserves an explicit homeUnit and never marks it unresolved", () => {
    const { toCreate, detected, unresolved } = planImport(
      [mk(1, { deviceName: "HI-XYZ-LT-001", homeUnit: "Explicit Unit" })],
      new Set(),
      UNITS,
    );
    expect(toCreate[0].homeUnit).toBe("Explicit Unit");
    expect(detected).toBe(0);
    expect(unresolved).toHaveLength(0);
  });

  it("reports unresolved rows with their segments when nothing matches", () => {
    const { toCreate, detected, unresolved } = planImport(
      [mk(1, { deviceName: "HI-XYZ-LT-001", homeUnit: "" })],
      new Set(),
      UNITS,
    );
    expect(toCreate[0].homeUnit).toBeUndefined();
    expect(detected).toBe(0);
    expect(unresolved).toEqual([{ row: 1, deviceName: "HI-XYZ-LT-001", segments: ["HI", "XYZ", "LT", "001"] }]);
  });
});
