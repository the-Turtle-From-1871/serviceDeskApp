import { describe, it, expect } from "vitest";
import { parseServiceMap, parseOverrideDays } from "./service-form";

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
    expect(m.get("i1")).toEqual({ serviceType: "REIMAGE", note: null, overrideDays: null });
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
    expect(m.get("i1")).toEqual({ serviceType: "OTHER", note: "cracked screen", overrideDays: null });
    expect(m.get("i2")).toEqual({ serviceType: "REPAIR", note: null, overrideDays: null });
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
    expect(m.get("i1")).toEqual({ serviceType: "OTHER", note: null, overrideDays: null });
  });

  it("captures a per-item override days value", () => {
    const fd = new FormData();
    fd.set("service[i1][needs]", "on");
    fd.set("service[i1][type]", "REPAIR");
    fd.set("service[i1][days]", "2");
    const sel = parseServiceMap(fd).get("i1");
    expect(sel?.overrideDays).toBe(2);
  });

  it("leaves overrideDays null when the days field is absent or blank", () => {
    const fd = new FormData();
    fd.set("service[i1][needs]", "on");
    fd.set("service[i1][type]", "REIMAGE");
    const sel = parseServiceMap(fd).get("i1");
    expect(sel?.overrideDays ?? null).toBeNull();
  });

  it("leaves overrideDays null when the days field is explicitly blank", () => {
    const fd = new FormData();
    fd.set("service[i1][needs]", "on");
    fd.set("service[i1][type]", "REIMAGE");
    fd.set("service[i1][days]", "");
    const sel = parseServiceMap(fd).get("i1");
    expect(sel?.overrideDays).toBeNull();
  });

  it("falls back to null (type default) when days exceeds the 1..3650 bound", () => {
    const fd = new FormData();
    fd.set("service[i1][needs]", "on");
    fd.set("service[i1][type]", "REPAIR");
    fd.set("service[i1][days]", "99999999");
    const sel = parseServiceMap(fd).get("i1");
    // Out-of-range must not reach computeServiceDueAt (would be an Invalid Date
    // the best-effort enqueue silently drops) — it falls back to the default SLA.
    expect(sel?.overrideDays).toBeNull();
  });

  it("accepts the 3650 upper bound", () => {
    const fd = new FormData();
    fd.set("service[i1][needs]", "on");
    fd.set("service[i1][type]", "REPAIR");
    fd.set("service[i1][days]", "3650");
    const sel = parseServiceMap(fd).get("i1");
    expect(sel?.overrideDays).toBe(3650);
  });

  it("rejects non-integer / garbage day values (no parseInt truncation)", () => {
    for (const bad of ["12.9", "12abc", "0", "-5"]) {
      const fd = new FormData();
      fd.set("service[i1][needs]", "on");
      fd.set("service[i1][type]", "REPAIR");
      fd.set("service[i1][days]", bad);
      expect(parseServiceMap(fd).get("i1")?.overrideDays).toBeNull();
    }
  });
});

describe("parseOverrideDays", () => {
  it("returns a whole 1..3650 day count", () => {
    expect(parseOverrideDays("5")).toBe(5);
    expect(parseOverrideDays("1")).toBe(1);
    expect(parseOverrideDays("3650")).toBe(3650);
    expect(parseOverrideDays(" 7 ")).toBe(7); // trimmed
  });
  it("returns undefined (→ type default) for blank, malformed, or out-of-range", () => {
    for (const bad of ["", "   ", "0", "3651", "99999999", "12.9", "12abc", "-5", "abc", null, undefined]) {
      expect(parseOverrideDays(bad)).toBeUndefined();
    }
  });
});
