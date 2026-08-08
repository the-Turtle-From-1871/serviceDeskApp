import { describe, it, expect } from "vitest";
import { parseScan, expressServiceCodeToServiceTag } from "./scan-code";

describe("expressServiceCodeToServiceTag", () => {
  // A Dell service tag is 7 chars of base 36; the Express Service Code printed
  // beside it on the same label is that same value in base 10.
  it("converts an express service code back to its service tag", () => {
    expect(expressServiceCodeToServiceTag("17237164935")).toBe("7X2K9L3");
    expect(expressServiceCodeToServiceTag("42938741054")).toBe("JQ4M8N2");
    expect(expressServiceCodeToServiceTag("38814517047")).toBe("HTX5T13");
  });

  // A tag beginning with 0 loses that character in the numeric form. Padding is
  // what restores it — without padStart this returns a 6-char string that
  // matches no item.
  it("restores a leading zero the numeric form drops", () => {
    expect(expressServiceCodeToServiceTag("623698779")).toBe("0ABC123");
  });

  it("refuses anything that is not an 8-11 digit number", () => {
    expect(expressServiceCodeToServiceTag("7X2K9L3")).toBeNull(); // the tag itself
    expect(expressServiceCodeToServiceTag("1234567")).toBeNull(); // too short
    expect(expressServiceCodeToServiceTag("123456789012")).toBeNull(); // too long
    expect(expressServiceCodeToServiceTag("")).toBeNull();
  });
});

describe("parseScan", () => {
  it("recognises our own QR sticker, absolute and bare-path", () => {
    expect(parseScan("https://www.dcsim.us/i/abc123")).toEqual({ kind: "item", id: "abc123" });
    expect(parseScan("/i/abc123")).toEqual({ kind: "item", id: "abc123" });
  });

  it("reads a Dell service tag as a serial", () => {
    expect(parseScan("7X2K9L3")).toEqual({ kind: "serial", serial: "7X2K9L3" });
  });

  it("reads an HP serial as a serial", () => {
    expect(parseScan("5CD1234ABC")).toEqual({ kind: "serial", serial: "5CD1234ABC" });
  });

  // The raw value is tried FIRST and the conversion offered as a fallback, so a
  // genuinely numeric serial can never be silently rewritten into a wrong tag.
  it("offers the converted tag as an alternative, never as a replacement", () => {
    expect(parseScan("17237164935")).toEqual({
      kind: "serial",
      serial: "17237164935",
      altSerial: "7X2K9L3",
    });
  });

  it("does not lowercase or otherwise rewrite the value", () => {
    // serialNumber is citext, so matching is already case-insensitive; folding
    // case here would put a second casing rule in a second place.
    expect(parseScan("7x2k9l3")).toEqual({ kind: "serial", serial: "7x2k9l3" });
  });

  it("rejects a Dell PPID and other punctuated strings", () => {
    expect(parseScan("CN-0ABCDE-12345-ABC-1234-A00")).toBeNull();
    expect(parseScan("WIFI:S:guest;T:WPA;P:hunter2;;")).toBeNull();
  });

  it("rejects blank, too-short and too-long input", () => {
    expect(parseScan("")).toBeNull();
    expect(parseScan("   ")).toBeNull();
    expect(parseScan("AB")).toBeNull();
    expect(parseScan("A".repeat(21))).toBeNull();
  });

  it("trims surrounding whitespace", () => {
    expect(parseScan("  7X2K9L3  ")).toEqual({ kind: "serial", serial: "7X2K9L3" });
  });
});
