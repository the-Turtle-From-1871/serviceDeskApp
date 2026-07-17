import { describe, it, expect } from "vitest";
import { SLA_DAYS, computeServiceDueAt } from "./sla";

const FROM = new Date("2026-07-17T00:00:00.000Z");
const daysBetween = (a: Date, b: Date) => Math.round((a.getTime() - b.getTime()) / (24 * 60 * 60 * 1000));

describe("SLA_DAYS", () => {
  it("has the agreed per-type defaults", () => {
    expect(SLA_DAYS).toEqual({ REIMAGE: 3, REPAIR: 7, OTHER: 5 });
  });
});

describe("computeServiceDueAt", () => {
  it("uses the type default when no override is given", () => {
    expect(daysBetween(computeServiceDueAt("REPAIR", FROM), FROM)).toBe(7);
  });
  it("uses the override when provided", () => {
    expect(daysBetween(computeServiceDueAt("REPAIR", FROM, 2), FROM)).toBe(2);
  });
  it("ignores a null override and falls back to the default", () => {
    expect(daysBetween(computeServiceDueAt("REIMAGE", FROM, null), FROM)).toBe(3);
  });
});
