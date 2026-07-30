import { describe, it, expect } from "vitest";
import { isImportStale, STALE_IMPORT_HOURS } from "./import-freshness";

const NOW = new Date("2026-07-29T00:00:00.000Z");
const hoursAgo = (n: number) => new Date(NOW.getTime() - n * 60 * 60 * 1000);

describe("isImportStale", () => {
  it("is not stale when no import has ever run (null)", () => {
    expect(isImportStale(null, NOW)).toBe(false);
  });

  it("is not stale when comfortably fresh", () => {
    expect(isImportStale(hoursAgo(1), NOW)).toBe(false);
  });

  it("is not stale just under the threshold", () => {
    expect(isImportStale(hoursAgo(STALE_IMPORT_HOURS - 1), NOW)).toBe(false);
  });

  it("is not stale exactly at the threshold (strictly-greater-than semantics)", () => {
    expect(isImportStale(hoursAgo(STALE_IMPORT_HOURS), NOW)).toBe(false);
  });

  it("is stale just over the threshold", () => {
    expect(isImportStale(hoursAgo(STALE_IMPORT_HOURS + 1), NOW)).toBe(true);
  });

  it("is not stale for a future-dated timestamp (clock skew, not an expiry)", () => {
    const future = new Date(NOW.getTime() + 60 * 60 * 1000);
    expect(isImportStale(future, NOW)).toBe(false);
  });
});
