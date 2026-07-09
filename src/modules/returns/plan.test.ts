import { describe, it, expect } from "vitest";
import { planReturn, type HeldItem } from "./plan";

const held: HeldItem[] = [
  { transferItemId: "a", serialNumber: "SN-A", make: "Dell", model: "5540", lineNo: 1 },
  { transferItemId: "b", serialNumber: "SN-B", make: "Dell", model: "5540", lineNo: 1 },
  { transferItemId: "c", serialNumber: "SN-C", make: "PVS", model: "14", lineNo: 2 },
];

describe("planReturn", () => {
  it("returns a subset as PARTIAL with per-line before/after counts", () => {
    const { plan, error } = planReturn(held, ["a"]);
    expect(error).toBeUndefined();
    expect(plan!.kind).toBe("PARTIAL");
    expect(plan!.returned.map((r) => r.transferItemId)).toEqual(["a"]);
    expect(plan!.remaining.map((r) => r.transferItemId).sort()).toEqual(["b", "c"]);
    const line1 = plan!.byLine.find((l) => l.lineNo === 1)!;
    expect(line1).toMatchObject({ heldBefore: 2, returnedNow: 1, heldAfter: 1 });
    const line2 = plan!.byLine.find((l) => l.lineNo === 2)!;
    expect(line2).toMatchObject({ heldBefore: 1, returnedNow: 0, heldAfter: 1 });
  });

  it("returns everything as FULL", () => {
    const { plan } = planReturn(held, ["a", "b", "c"]);
    expect(plan!.kind).toBe("FULL");
    expect(plan!.remaining).toHaveLength(0);
    expect(plan!.byLine.every((l) => l.heldAfter === 0)).toBe(true);
  });

  it("dedupes repeated ids", () => {
    const { plan } = planReturn(held, ["a", "a"]);
    expect(plan!.returned).toHaveLength(1);
  });

  it("errors on an empty selection", () => {
    const { plan, error } = planReturn(held, []);
    expect(plan).toBeUndefined();
    expect(error).toMatch(/at least one/i);
  });

  it("errors when a selected id is not currently held", () => {
    const { plan, error } = planReturn(held, ["zzz"]);
    expect(plan).toBeUndefined();
    expect(error).toMatch(/not currently held/i);
  });
});
