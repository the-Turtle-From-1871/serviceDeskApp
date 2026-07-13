import { describe, it, expect } from "vitest";
import {
  PURGE_WINDOW_DAYS,
  computePurgeAfter,
  isTransferClosed,
  assertTransferOpen,
  isPurgeEligible,
} from "./lifecycle";
import { TransferError } from "./transfers.errors";

describe("computePurgeAfter", () => {
  it("returns exactly 90 days after closedAt", () => {
    const closedAt = new Date("2026-01-01T00:00:00.000Z");
    const purge = computePurgeAfter(closedAt);
    const days = (purge.getTime() - closedAt.getTime()) / (24 * 60 * 60 * 1000);
    expect(days).toBe(PURGE_WINDOW_DAYS);
    expect(purge.toISOString()).toBe("2026-04-01T00:00:00.000Z");
  });

  it("does not mutate the input date", () => {
    const closedAt = new Date("2026-01-01T00:00:00.000Z");
    computePurgeAfter(closedAt);
    expect(closedAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("isTransferClosed", () => {
  it("is true when status is CLOSED", () => {
    expect(isTransferClosed({ status: "CLOSED", closedAt: null })).toBe(true);
  });
  it("is true when closedAt is set even if status lags", () => {
    expect(isTransferClosed({ status: "OPEN", closedAt: new Date() })).toBe(true);
  });
  it("is false for an open, unstamped receipt", () => {
    expect(isTransferClosed({ status: "OPEN", closedAt: null })).toBe(false);
  });
});

describe("assertTransferOpen", () => {
  it("throws TransferError(CLOSED) for a closed receipt", () => {
    try {
      assertTransferOpen({ status: "CLOSED", closedAt: new Date() });
      throw new Error("expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(TransferError);
      expect((e as TransferError).code).toBe("CLOSED");
    }
  });
  it("does not throw for an open receipt", () => {
    expect(() => assertTransferOpen({ status: "OPEN", closedAt: null })).not.toThrow();
  });
});

describe("isPurgeEligible", () => {
  const now = new Date("2026-05-01T00:00:00.000Z");
  it("is false when purgeAfter is null (still open)", () => {
    expect(isPurgeEligible({ purgeAfter: null }, now)).toBe(false);
  });
  it("is true once purgeAfter has passed", () => {
    expect(isPurgeEligible({ purgeAfter: new Date("2026-04-30T23:59:59.000Z") }, now)).toBe(true);
  });
  it("is true exactly at the boundary", () => {
    expect(isPurgeEligible({ purgeAfter: new Date(now) }, now)).toBe(true);
  });
  it("is false when purgeAfter is still in the future", () => {
    expect(isPurgeEligible({ purgeAfter: new Date("2026-05-01T00:00:01.000Z") }, now)).toBe(false);
  });
});
