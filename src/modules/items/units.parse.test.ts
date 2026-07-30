import { describe, it, expect } from "vitest";
import { parseUnitBlock } from "./units.parse";

describe("parseUnitBlock", () => {
  it("parses ABBREV,Full Name lines and ignores blanks", () => {
    expect(parseUnitBlock("WABC01,HHC 1-8\n\n  WDEF02 , B CO 44  \n")).toEqual({
      units: [
        { abbreviation: "WABC01", fullName: "HHC 1-8" },
        { abbreviation: "WDEF02", fullName: "B CO 44" },
      ],
      errors: [],
    });
  });

  it("reports a line with no comma rather than silently dropping it", () => {
    const res = parseUnitBlock("WABC01,HHC 1-8\nnonsense");
    expect(res.units).toHaveLength(1);
    expect(res.errors[0]).toMatch(/line 2/i);
  });

  it("reports an abbreviation with characters the schema forbids", () => {
    const res = parseUnitBlock("W-ABC,Some Unit");
    expect(res.units).toHaveLength(0);
    expect(res.errors[0]).toMatch(/line 1/i);
  });
});
