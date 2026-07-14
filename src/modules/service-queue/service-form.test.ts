import { describe, it, expect } from "vitest";
import { parseServiceMap } from "./service-form";

function fd(entries: [string, string][]): FormData {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
}

describe("parseServiceMap", () => {
  it("includes only checked items with a valid type", () => {
    const f = fd([
      ["service[i1][needs]", "on"],
      ["service[i1][type]", "REIMAGE"],
      ["service[i2][type]", "REPAIR"], // not checked -> excluded
      ["service[i3][needs]", "on"],
      ["service[i3][type]", "BOGUS"], // invalid -> excluded
    ]);
    const m = parseServiceMap(f);
    expect([...m.keys()]).toEqual(["i1"]);
    expect(m.get("i1")).toEqual({ serviceType: "REIMAGE", note: null });
  });

  it("captures the trimmed note for OTHER and null otherwise", () => {
    const f = fd([
      ["service[i1][needs]", "on"],
      ["service[i1][type]", "OTHER"],
      ["service[i1][note]", "  cracked screen "],
      ["service[i2][needs]", "on"],
      ["service[i2][type]", "REPAIR"],
      ["service[i2][note]", "ignored for non-OTHER"],
    ]);
    const m = parseServiceMap(f);
    expect(m.get("i1")).toEqual({ serviceType: "OTHER", note: "cracked screen" });
    expect(m.get("i2")).toEqual({ serviceType: "REPAIR", note: null });
  });

  it("returns an empty map when nothing is flagged", () => {
    expect(parseServiceMap(fd([])).size).toBe(0);
  });

  it("normalizes a whitespace-only OTHER note to null", () => {
    const f = fd([
      ["service[i1][needs]", "on"],
      ["service[i1][type]", "OTHER"],
      ["service[i1][note]", "   "],
    ]);
    const m = parseServiceMap(f);
    expect(m.get("i1")).toEqual({ serviceType: "OTHER", note: null });
  });
});
