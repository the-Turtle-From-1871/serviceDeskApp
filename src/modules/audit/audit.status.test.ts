import { describe, it, expect } from "vitest";
import { AUDIT_ORDER, auditCutoff, auditState, auditStateDisplay } from "./audit.status";

describe("AUDIT_ORDER", () => {
  // auditRankSql builds its CASE from this array and has NO `ELSE`, so a state
  // missing here would rank NULL and sort every row carrying it to one end of
  // /items without any error. `satisfies` only checks each entry IS an
  // AuditState — it cannot check that all of them are present, which is why
  // this asserts exhaustiveness against the display map instead.
  it("ranks every AuditState", () => {
    const everyState = (["compliant", "overdue", "never"] as const).map((s) => {
      // Fails to compile if the union grows and this list does not.
      expect(auditStateDisplay(s).label).toBeTruthy();
      return s;
    });
    expect([...AUDIT_ORDER].sort()).toEqual([...everyState].sort());
  });

  it("runs best-verified to least, matching the analytics donut", () => {
    expect([...AUDIT_ORDER]).toEqual(["compliant", "overdue", "never"]);
  });
});

describe("auditState", () => {
  it("returns 'never' when there is no audit date", () => {
    expect(auditState(null, new Date("2026-07-16T00:00:00Z"))).toBe("never");
  });

  it("returns 'compliant' within one year of the last audit", () => {
    const last = new Date("2026-01-01T00:00:00Z");
    expect(auditState(last, new Date("2026-12-31T00:00:00Z"))).toBe("compliant");
  });

  it("returns 'overdue' exactly one year later (boundary is not compliant)", () => {
    const last = new Date("2025-01-01T00:00:00Z");
    expect(auditState(last, new Date("2026-01-01T00:00:00Z"))).toBe("overdue");
  });

  it("returns 'overdue' more than one year after the last audit", () => {
    const last = new Date("2024-01-01T00:00:00Z");
    expect(auditState(last, new Date("2026-07-16T00:00:00Z"))).toBe("overdue");
  });

  it("handles a leap-day audit (2024-02-29 + 1yr normalizes to 2025-03-01)", () => {
    const last = new Date("2024-02-29T00:00:00Z");
    expect(auditState(last, new Date("2025-02-28T00:00:00Z"))).toBe("compliant");
    expect(auditState(last, new Date("2025-03-02T00:00:00Z"))).toBe("overdue");
  });
});

/* auditCutoff is what the analytics donut buckets on in SQL (`lastAuditedAt >
   cutoff` = compliant). auditState is what the per-item badge shows. If those
   two ever disagree, the dashboard and the item list report different fleets —
   so the contract under test is that they classify the SAME dates the same way,
   not merely that the arithmetic looks right. */
describe("auditCutoff", () => {
  const classify = (last: Date, now: Date) => (last > auditCutoff(now) ? "compliant" : "overdue");

  it("agrees with auditState on both sides of the boundary", () => {
    const now = new Date("2026-07-27T00:00:00Z");
    const inside = new Date("2026-07-26T00:00:00Z");
    const outside = new Date("2024-01-01T00:00:00Z");

    expect(classify(inside, now)).toBe("compliant");
    expect(auditState(inside, now)).toBe("compliant");
    expect(classify(outside, now)).toBe("overdue");
    expect(auditState(outside, now)).toBe("overdue");
  });

  it("treats the boundary itself as overdue, exactly as auditState does", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const exactlyAYearAgo = new Date("2025-01-01T00:00:00Z");

    expect(classify(exactlyAYearAgo, now)).toBe("overdue");
    expect(auditState(exactlyAYearAgo, now)).toBe("overdue");
  });

  it("is exactly one audit period before `now`", () => {
    expect(auditCutoff(new Date("2026-07-27T12:34:56Z")).toISOString()).toBe("2025-07-27T12:34:56.000Z");
  });
});

describe("auditStateDisplay", () => {
  it("maps each state to a label and dot class", () => {
    expect(auditStateDisplay("compliant")).toEqual({ label: "Compliant", className: "audit-dot--compliant" });
    expect(auditStateDisplay("overdue")).toEqual({ label: "Overdue", className: "audit-dot--overdue" });
    expect(auditStateDisplay("never")).toEqual({ label: "Never audited", className: "audit-dot--never" });
  });
});
