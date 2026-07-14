import { describe, it, expect } from "vitest";
import { splitSegments, detectHomeUnit } from "./unit-detect";

const units = new Map<string, string>([
  ["DCSIM", "DCSIM"],
  ["487B", "487FA BATTERY B"],
]);

describe("splitSegments", () => {
  it("splits on hyphen and underscore, trims, drops empties", () => {
    expect(splitSegments("HI-DCSIM_LT-001")).toEqual(["HI", "DCSIM", "LT", "001"]);
    expect(splitSegments("  DCSIM ")).toEqual(["DCSIM"]);
    expect(splitSegments("A--B")).toEqual(["A", "B"]);
  });
});

describe("detectHomeUnit", () => {
  it("matches an abbreviation in any segment position", () => {
    expect(detectHomeUnit("HI-DCSIM-LT-001", units)).toBe("DCSIM");
    expect(detectHomeUnit("487B-DESKTOP-03", units)).toBe("487FA BATTERY B");
  });

  it("is case-insensitive", () => {
    expect(detectHomeUnit("hi-dcsim-lt-001", units)).toBe("DCSIM");
  });

  it("returns the first matching segment when several could match", () => {
    const m = new Map([["HI", "Headquarters"], ["DCSIM", "DCSIM"]]);
    expect(detectHomeUnit("HI-DCSIM-01", m)).toBe("Headquarters");
  });

  it("returns undefined when no segment matches", () => {
    expect(detectHomeUnit("HI-XYZ-LT-001", units)).toBeUndefined();
    expect(detectHomeUnit("", units)).toBeUndefined();
  });
});
