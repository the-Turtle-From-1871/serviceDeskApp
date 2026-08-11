import { describe, it, expect } from "vitest";
import { buildRenameSequence, MAX_RENAME_PREFIX, RenameSequenceError } from "./rename-sequence";

describe("buildRenameSequence", () => {
  it("pads to the width of the start value as typed", () => {
    expect(buildRenameSequence(3, "LAPTOP", "001")).toEqual([
      "LAPTOP-001", "LAPTOP-002", "LAPTOP-003",
    ]);
    expect(buildRenameSequence(2, "LAPTOP", "01")).toEqual(["LAPTOP-01", "LAPTOP-02"]);
    expect(buildRenameSequence(2, "LAPTOP", "1")).toEqual(["LAPTOP-1", "LAPTOP-2"]);
  });

  it("treats the width as a MINIMUM and grows past it", () => {
    // 95..99 fit in two digits; 100 does not, and must not wrap or be refused.
    expect(buildRenameSequence(6, "X", "95")).toEqual([
      "X-95", "X-96", "X-97", "X-98", "X-99", "X-100",
    ]);
  });

  it("starts from zero when asked to", () => {
    expect(buildRenameSequence(2, "X", "000")).toEqual(["X-000", "X-001"]);
  });

  it("trims the prefix", () => {
    expect(buildRenameSequence(1, "  LAPTOP  ", "001")).toEqual(["LAPTOP-001"]);
  });

  it("refuses a blank prefix", () => {
    expect(() => buildRenameSequence(1, "   ", "001")).toThrow(RenameSequenceError);
    expect(() => buildRenameSequence(1, "", "001")).toThrow(
      expect.objectContaining({ code: "PREFIX_REQUIRED" }),
    );
  });

  it("refuses an over-long prefix", () => {
    const long = "A".repeat(MAX_RENAME_PREFIX + 1);
    expect(() => buildRenameSequence(1, long, "001")).toThrow(
      expect.objectContaining({ code: "PREFIX_TOO_LONG" }),
    );
  });

  it("refuses a start that is not digits only", () => {
    for (const bad of ["", "1a", "-1", "1.5", " 1", "0x10"]) {
      expect(() => buildRenameSequence(1, "X", bad)).toThrow(
        expect.objectContaining({ code: "START_NOT_DIGITS" }),
      );
    }
  });

  it("refuses a start whose range would exceed safe integers", () => {
    expect(() => buildRenameSequence(1, "X", "9".repeat(20))).toThrow(
      expect.objectContaining({ code: "START_OUT_OF_RANGE" }),
    );
  });

  it("refuses a non-positive or non-integer count", () => {
    for (const bad of [0, -1, 1.5, NaN]) {
      expect(() => buildRenameSequence(bad, "X", "001")).toThrow(
        expect.objectContaining({ code: "COUNT_INVALID" }),
      );
    }
  });
});
