import { describe, it, expect } from "vitest";
import { formatParty } from "./party";

describe("formatParty", () => {
  it("DCSIM party ignores rank/unit", () => {
    expect(formatParty({ isDcsim: true, name: "Josh", rank: "SSG", unit: "A Co" })).toBe("DCSIM · Josh");
  });
  it("rank + name + unit", () => {
    expect(formatParty({ isDcsim: false, name: "Doe", rank: "SGT", unit: "A Co 1-1 IN" })).toBe("SGT Doe (A Co 1-1 IN)");
  });
  it("rank + name, no unit", () => {
    expect(formatParty({ isDcsim: false, name: "Doe", rank: "SGT", unit: null })).toBe("SGT Doe");
  });
  it("name only", () => {
    expect(formatParty({ isDcsim: false, name: "Doe", rank: null, unit: null })).toBe("Doe");
  });
});
