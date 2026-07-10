import { describe, it, expect } from "vitest";
import { planImport } from "./import";
import type { RawRow } from "./csv";

const mk = (row: number, over: Partial<RawRow> = {}): RawRow =>
  ({ row, make: "M4", model: "Carbine", serialNumber: `S${row}`, deviceName: "Radio", homeUnit: "", notes: "", ...over });

describe("planImport", () => {
  it("keeps valid, non-duplicate rows", () => {
    const { toCreate, skipped } = planImport([mk(1), mk(2)], new Set());
    expect(toCreate).toHaveLength(2);
    expect(skipped).toHaveLength(0);
    expect(toCreate[0]).toMatchObject({ make: "M4", model: "Carbine", serialNumber: "S1" });
  });

  it("skips a row whose serial already exists in the DB", () => {
    const { toCreate, skipped } = planImport([mk(1, { serialNumber: "A1" })], new Set(["A1"]));
    expect(toCreate).toHaveLength(0);
    expect(skipped).toEqual([{ row: 1, serialNumber: "A1", reason: "already exists" }]);
  });

  it("keeps the first and skips later duplicates within the file", () => {
    const { toCreate, skipped } = planImport(
      [mk(1, { serialNumber: "D1" }), mk(2, { serialNumber: "D1" })],
      new Set()
    );
    expect(toCreate).toHaveLength(1);
    expect(skipped).toEqual([{ row: 2, serialNumber: "D1", reason: "duplicate in file" }]);
  });

  it("skips an invalid row with the validation message", () => {
    const { toCreate, skipped } = planImport([mk(1, { model: "" })], new Set());
    expect(toCreate).toHaveLength(0);
    expect(skipped[0]).toMatchObject({ row: 1, reason: "Model is required" });
  });

  it("skips a row with a blank device name", () => {
    const { toCreate, skipped } = planImport([mk(1, { deviceName: "" })], new Set());
    expect(toCreate).toHaveLength(0);
    expect(skipped[0].reason).toMatch(/device name/i);
  });
});
