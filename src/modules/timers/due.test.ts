import { describe, it, expect } from "vitest";
import { computeDueAt, dueState, DUE_SOON_DAYS } from "./due";

const NOW = new Date("2026-07-17T00:00:00.000Z");
const day = (n: number) => new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000);

describe("computeDueAt", () => {
  it("adds whole days without mutating the input", () => {
    expect(computeDueAt(NOW, 30).toISOString()).toBe("2026-08-16T00:00:00.000Z");
    expect(NOW.toISOString()).toBe("2026-07-17T00:00:00.000Z");
  });
});

describe("dueState", () => {
  it("is 'none' with 0 days when there is no timer", () => {
    expect(dueState(null, NOW)).toEqual({ state: "none", days: 0 });
  });
  it("is 'overdue' with negative days once the deadline has passed", () => {
    expect(dueState(day(-2), NOW)).toEqual({ state: "overdue", days: -2 });
  });
  it("is 'overdue' exactly at the boundary", () => {
    expect(dueState(new Date(NOW), NOW)).toMatchObject({ state: "overdue" });
  });
  it("is 'soon' within the due-soon window", () => {
    expect(dueState(day(DUE_SOON_DAYS), NOW)).toMatchObject({ state: "soon", days: DUE_SOON_DAYS });
  });
  it("is 'ontrack' beyond the due-soon window", () => {
    expect(dueState(day(10), NOW)).toEqual({ state: "ontrack", days: 10 });
  });
  it("is 'soon' when due in less than a day (days rounds to 0)", () => {
    const halfDay = new Date(NOW.getTime() + 12 * 60 * 60 * 1000);
    expect(dueState(halfDay, NOW)).toEqual({ state: "soon", days: 0 });
  });
});
