import { describe, it, expect } from "vitest";
import {
  readinessState,
  parseMdmDateTime,
  READINESS_ORDER,
  READINESS_LABEL,
  type ReadinessSignals,
} from "./readiness";

const base: ReadinessSignals = {
  status: "ACTIVE",
  flaggedForService: false,
  onOpenReceipt: false,
  lastLogonAt: null,
  lastLogonUser: null,
  markedReadyAt: null,
};
const s = (over: Partial<ReadinessSignals> = {}): ReadinessSignals => ({ ...base, ...over });

const JAN = new Date("2026-01-01T00:00:00Z");
const JUN = new Date("2026-06-01T00:00:00Z");

describe("READINESS_ORDER", () => {
  it("ranks every state exactly once", () => {
    // The /items readiness sort turns this list into a SQL rank with no ELSE
    // branch (READINESS_RANK). A state missing here would rank NULL and dump
    // that whole bucket at one end of the table; a duplicate would give two
    // states the same rank. READINESS_LABEL is a Record over ReadinessState, so
    // its keys are the complete set by construction.
    expect([...READINESS_ORDER].sort()).toEqual(Object.keys(READINESS_LABEL).sort());
  });
});

describe("readinessState", () => {
  it("reports UNTRIAGED when nothing is known", () => {
    expect(readinessState(s())).toBe("UNTRIAGED");
  });

  it("RETIRED outranks every other signal", () => {
    expect(
      readinessState(s({
        status: "RETIRED",
        flaggedForService: true,
        onOpenReceipt: true,
        lastLogonUser: "a@b.mil",
        markedReadyAt: JAN,
      })),
    ).toBe("RETIRED");
  });

  it("a service flag outranks an open receipt", () => {
    // The whole reason the receipt rule is safe: a device turned in for repair
    // while its receipt is still open must not read Deployed.
    expect(readinessState(s({ flaggedForService: true, onOpenReceipt: true }))).toBe("IN_REPAIR");
  });

  it("a service flag outranks the MDM last-logon signal", () => {
    expect(readinessState(s({ flaggedForService: true, lastLogonUser: "a@b.mil" }))).toBe("IN_REPAIR");
  });

  it("an open receipt means DEPLOYED immediately, with no import needed", () => {
    expect(readinessState(s({ onOpenReceipt: true }))).toBe("DEPLOYED");
  });

  it("an open receipt outranks a fresh on-hand marking", () => {
    expect(readinessState(s({ onOpenReceipt: true, markedReadyAt: JUN }))).toBe("DEPLOYED");
  });

  it("marking it on hand makes it READY_TO_DEPLOY", () => {
    expect(readinessState(s({ markedReadyAt: JAN }))).toBe("READY_TO_DEPLOY");
  });

  it("a marking beats a STALE logon that predates it", () => {
    // Shelved in June after being used in January -> it is on the shelf.
    expect(readinessState(s({ markedReadyAt: JUN, lastLogonAt: JAN, lastLogonUser: "a@b.mil" }))).toBe(
      "READY_TO_DEPLOY",
    );
  });

  it("a logon AFTER the marking does NOT flip it back to DEPLOYED", () => {
    // The marking is a person stating they physically hold the device. A device
    // on our own shelf still produces logons — imaging it, an MDM check-in, a
    // test before reissue — and none of those mean it left. Only a deliberate
    // act (service flag, open receipt, retirement) overrides the marking.
    expect(readinessState(s({ markedReadyAt: JAN, lastLogonAt: JUN, lastLogonUser: "a@b.mil" }))).toBe(
      "READY_TO_DEPLOY",
    );
  });

  it("issuing it out on a hand receipt still overrides the marking", () => {
    // The case removing the logon rule must NOT break: giving a device to
    // someone is recorded as an open receipt, which outranks the marking and
    // fires immediately rather than waiting for the next MDM import.
    expect(
      readinessState(s({ markedReadyAt: JUN, onOpenReceipt: true, lastLogonAt: JAN, lastLogonUser: "a@b.mil" })),
    ).toBe("DEPLOYED");
  });

  it("keeps a marking when the logon instant is unparseable, even if a user is present", () => {
    // lastLogonAt null = "we don't know when", which must not silently beat an
    // explicit operator marking.
    expect(readinessState(s({ markedReadyAt: JAN, lastLogonAt: null, lastLogonUser: "a@b.mil" }))).toBe(
      "READY_TO_DEPLOY",
    );
  });

  it("falls back to DEPLOYED for a legacy device with only an MDM user", () => {
    // The ~1,053 devices in soldiers' hands that predate the app.
    expect(readinessState(s({ lastLogonUser: "a@b.mil" }))).toBe("DEPLOYED");
  });

  it("treats a blank MDM user as no signal", () => {
    expect(readinessState(s({ lastLogonUser: "   " }))).toBe("UNTRIAGED");
  });

  it("does not read DEPLOYED from a logon date with no user", () => {
    expect(readinessState(s({ lastLogonAt: JUN }))).toBe("UNTRIAGED");
  });
});

describe("parseMdmDateTime", () => {
  it("parses the MDM export's format", () => {
    expect(parseMdmDateTime("7/25/2026 1:40:21 AM")?.toISOString()).toBe("2026-07-25T01:40:21.000Z");
  });

  it("handles PM correctly", () => {
    expect(parseMdmDateTime("7/25/2026 1:40:21 PM")?.toISOString()).toBe("2026-07-25T13:40:21.000Z");
  });

  it("maps 12 AM to midnight and 12 PM to noon", () => {
    expect(parseMdmDateTime("7/25/2026 12:00:00 AM")?.toISOString()).toBe("2026-07-25T00:00:00.000Z");
    expect(parseMdmDateTime("7/25/2026 12:00:00 PM")?.toISOString()).toBe("2026-07-25T12:00:00.000Z");
  });

  it("accepts a date with no time", () => {
    expect(parseMdmDateTime("7/8/2025")?.toISOString()).toBe("2025-07-08T00:00:00.000Z");
  });

  it("accepts ISO-8601", () => {
    expect(parseMdmDateTime("2026-07-25T01:40:21Z")?.toISOString()).toBe("2026-07-25T01:40:21.000Z");
  });

  it("returns null for blank or missing input", () => {
    expect(parseMdmDateTime(null)).toBeNull();
    expect(parseMdmDateTime(undefined)).toBeNull();
    expect(parseMdmDateTime("   ")).toBeNull();
  });

  it("returns null rather than throwing on junk", () => {
    // An unparseable date must degrade to "unknown", never fail an import.
    expect(parseMdmDateTime("not a date")).toBeNull();
    expect(parseMdmDateTime("Never")).toBeNull();
  });

  it("rejects an impossible date instead of rolling it over", () => {
    // Date.UTC would silently turn 2/30 into 3/2.
    expect(parseMdmDateTime("2/30/2026")).toBeNull();
    expect(parseMdmDateTime("13/1/2026")).toBeNull();
  });
});
