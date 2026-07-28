import { describe, it, expect } from "vitest";
import { computeServiceDueAt, serviceDueAtUpdate } from "./sla";

const FROM = new Date("2026-07-17T00:00:00.000Z");
const daysBetween = (a: Date, b: Date) => Math.round((a.getTime() - b.getTime()) / (24 * 60 * 60 * 1000));

describe("computeServiceDueAt", () => {
  it("returns null when no days are given — blank means NO deadline, not a default", () => {
    expect(computeServiceDueAt(FROM)).toBeNull();
    expect(computeServiceDueAt(FROM, null)).toBeNull();
    expect(computeServiceDueAt(FROM, undefined)).toBeNull();
  });

  it("computes the deadline from an explicit day count", () => {
    const due = computeServiceDueAt(FROM, 2);
    expect(due).toBeInstanceOf(Date);
    expect(daysBetween(due!, FROM)).toBe(2);
  });

  it("does not mutate `from`", () => {
    const from = new Date(FROM);
    computeServiceDueAt(from, 5);
    expect(from.getTime()).toBe(FROM.getTime());
  });
});

describe("serviceDueAtUpdate", () => {
  it("writes NOTHING when no days are given — an update that says nothing about the deadline leaves it alone", () => {
    // The object is empty, not `{ dueAt: null }`: the column never reaches the
    // SQL, so the stored instant cannot be recomputed, rounded, or re-based.
    expect(serviceDueAtUpdate(undefined, FROM)).toEqual({});
    expect(serviceDueAtUpdate(null, FROM)).toEqual({});
    expect("dueAt" in serviceDueAtUpdate(undefined, FROM)).toBe(false);
    expect("overdueAlertedAt" in serviceDueAtUpdate(undefined, FROM)).toBe(false);
  });

  it("sets a fresh deadline and re-arms the alert for an explicit day count", () => {
    const update = serviceDueAtUpdate(2, FROM);
    expect(daysBetween(update.dueAt!, FROM)).toBe(2);
    expect(update.overdueAlertedAt).toBeNull();
  });

  it("cannot express CLEARING — that is only reachable through setServiceDeadline", () => {
    // Every falsy/blank input maps to "no change", never to null. This is what
    // makes an ordinary re-save incapable of wiping a deadline.
    for (const blank of [undefined, null]) {
      expect(serviceDueAtUpdate(blank, FROM).dueAt).toBeUndefined();
    }
  });
});
