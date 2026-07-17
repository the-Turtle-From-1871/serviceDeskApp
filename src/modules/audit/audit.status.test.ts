import { describe, it, expect } from "vitest";
import { auditState, auditStateDisplay } from "./audit.status";

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

describe("auditStateDisplay", () => {
  it("maps each state to a label and dot class", () => {
    expect(auditStateDisplay("compliant")).toEqual({ label: "Compliant", className: "audit-dot--compliant" });
    expect(auditStateDisplay("overdue")).toEqual({ label: "Overdue", className: "audit-dot--overdue" });
    expect(auditStateDisplay("never")).toEqual({ label: "Never audited", className: "audit-dot--never" });
  });
});
