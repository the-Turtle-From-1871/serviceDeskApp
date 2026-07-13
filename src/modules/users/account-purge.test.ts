import { describe, it, expect } from "vitest";
import {
  DEACTIVATION_PURGE_MONTHS,
  deactivationCutoff,
  isAccountPurgeEligible,
  hasBlockingReferences,
} from "./account-purge";

const now = new Date("2026-07-13T00:00:00.000Z");

describe("deactivationCutoff", () => {
  it("is exactly 3 months before now", () => {
    expect(DEACTIVATION_PURGE_MONTHS).toBe(3);
    expect(deactivationCutoff(now).toISOString()).toBe("2026-04-13T00:00:00.000Z");
  });
});

describe("isAccountPurgeEligible", () => {
  it("is true for an inactive account deactivated more than 3 months ago", () => {
    expect(isAccountPurgeEligible({ isActive: false, deactivatedAt: new Date("2026-01-01T00:00:00.000Z") }, now)).toBe(true);
  });

  it("is true exactly at the 3-month boundary", () => {
    expect(isAccountPurgeEligible({ isActive: false, deactivatedAt: new Date("2026-04-13T00:00:00.000Z") }, now)).toBe(true);
  });

  it("is false when deactivated less than 3 months ago", () => {
    expect(isAccountPurgeEligible({ isActive: false, deactivatedAt: new Date("2026-06-01T00:00:00.000Z") }, now)).toBe(false);
  });

  it("is false for an active account regardless of the timestamp", () => {
    expect(isAccountPurgeEligible({ isActive: true, deactivatedAt: new Date("2020-01-01T00:00:00.000Z") }, now)).toBe(false);
  });

  it("treats a null deactivatedAt as not-yet-eligible (safe default for backfill)", () => {
    expect(isAccountPurgeEligible({ isActive: false, deactivatedAt: null }, now)).toBe(false);
  });
});

describe("hasBlockingReferences", () => {
  it("blocks when the user still created items", () => {
    expect(hasBlockingReferences({ items: 1, importBatches: 0 })).toBe(true);
  });
  it("blocks when the user still created import batches", () => {
    expect(hasBlockingReferences({ items: 0, importBatches: 2 })).toBe(true);
  });
  it("allows deletion when there are no restrict-FK dependencies", () => {
    expect(hasBlockingReferences({ items: 0, importBatches: 0 })).toBe(false);
  });
});
