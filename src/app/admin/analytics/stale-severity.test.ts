import { describe, expect, test } from "vitest";
import {
  isNoncompliant,
  severityLabel,
  staleSeverity,
  SEVERITY_FILL,
  STALE_ESCALATE_DAYS,
} from "./stale-severity";
import { STALE_MIN_DAYS, STALE_MAX_DAYS } from "./analytics.types";

describe("staleSeverity", () => {
  test("30-59 days is the recent band, 60-90 the older one", () => {
    expect(staleSeverity(30, "compliant")).toBe("recent");
    expect(staleSeverity(59, "compliant")).toBe("recent");
    expect(staleSeverity(60, "compliant")).toBe("older");
    expect(staleSeverity(90, "compliant")).toBe("older");
  });

  test("bands on the escalation day itself, which belongs to the older band", () => {
    // Half-open like the window itself: exactly one band can claim a device
    // landing on 60, so a row can never be coloured twice or not at all.
    expect(staleSeverity(STALE_ESCALATE_DAYS - 1, "compliant")).toBe("recent");
    expect(staleSeverity(STALE_ESCALATE_DAYS, "compliant")).toBe("older");
  });

  test("covers both ends of the window", () => {
    expect(staleSeverity(STALE_MIN_DAYS, "compliant")).toBe("recent");
    expect(staleSeverity(STALE_MAX_DAYS, "compliant")).toBe("older");
  });

  test("non-compliance OUTRANKS age, at either end", () => {
    // The decision this file exists to record: a 30-day non-compliant device is
    // red, not yellow. If someone reorders the branches this fails.
    expect(staleSeverity(STALE_MIN_DAYS, "noncompliant")).toBe("noncompliant");
    expect(staleSeverity(STALE_MAX_DAYS, "noncompliant")).toBe("noncompliant");
  });

  test("a compliant device keeps its age band", () => {
    expect(staleSeverity(45, "compliant")).toBe("recent");
    expect(staleSeverity(75, "compliant")).toBe("older");
  });
});

describe("isNoncompliant", () => {
  test("matches the export's value regardless of casing or padding", () => {
    // Item.compliance is free text copied verbatim from the CSV, so nothing
    // guarantees Intune's exact casing survives a re-cut of the export.
    for (const v of ["noncompliant", "NonCompliant", "NONCOMPLIANT", "  noncompliant  ", "Non-Compliant", "not compliant"]) {
      expect(isNoncompliant(v), v).toBe(true);
    }
  });

  test("compliant, grace period, blank and unknown are NOT red", () => {
    // Grace is "out of policy but not yet enforced" and blank is "the export
    // said nothing" — neither is a device that is actually blocked, and both
    // would overstate the count if coloured the same.
    for (const v of ["compliant", "Compliant", "inGracePeriod", "", "   ", null, undefined, "unknown"]) {
      expect(isNoncompliant(v), String(v)).toBe(false);
    }
  });
});

describe("SEVERITY_FILL", () => {
  test("every severity has a fill, and no two share one", () => {
    // A missing entry would render an uncoloured row that reads as "fine".
    const fills = Object.values(SEVERITY_FILL);
    expect(fills).toHaveLength(3);
    expect(new Set(fills).size).toBe(3);
    for (const f of fills) expect(f).toMatch(/^#[0-9A-F]{6}$/i);
  });

  test("the fills descend in lightness, so the ordering survives greyscale", () => {
    // The bands must stay distinguishable printed in black and white, and for a
    // reader who cannot separate the hues.
    const lum = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    expect(lum(SEVERITY_FILL.recent)).toBeGreaterThan(lum(SEVERITY_FILL.older));
    expect(lum(SEVERITY_FILL.older)).toBeGreaterThan(lum(SEVERITY_FILL.noncompliant));
  });
});

describe("severityLabel", () => {
  test("names the bands from the window constants, not hardcoded numbers", () => {
    expect(severityLabel("recent")).toBe(`${STALE_MIN_DAYS}–${STALE_ESCALATE_DAYS - 1} days since sync`);
    expect(severityLabel("older")).toBe(`${STALE_ESCALATE_DAYS}–${STALE_MAX_DAYS} days since sync`);
    expect(severityLabel("noncompliant")).toBe("Not compliant");
  });

  test("the escalation point sits inside the window", () => {
    // Derived from the window ends, so widening the window cannot strand a band
    // boundary outside it.
    expect(STALE_ESCALATE_DAYS).toBeGreaterThan(STALE_MIN_DAYS);
    expect(STALE_ESCALATE_DAYS).toBeLessThan(STALE_MAX_DAYS);
  });
});
