import { describe, it, expect } from "vitest";
import { parseScan, parseScans, describeScan, expressServiceCodeToServiceTag } from "./scan-code";

describe("parseScans", () => {
  // A service label is several codes at once and the decoder returns all of
  // them. Taking only the first hit meant a label whose usable code was not
  // first never reached the parser.
  it("takes the first value in the frame that parses, not the first value", () => {
    expect(parseScans(["1AB23AV#ABA", "CN-0ABCDE-1", "SN:2TK44202X4"]))
      .toEqual({ kind: "serial", serial: "2TK44202X4" });
  });

  it("prefers our own sticker when it shares the frame with a factory label", () => {
    expect(parseScans(["/i/abc123", "5CD1234ABC"])).toEqual({ kind: "item", id: "abc123" });
  });

  it("is null when nothing in the frame parses", () => {
    expect(parseScans([])).toBeNull();
    expect(parseScans(["CN-0ABCDE-12345-ABC-1234-A00", "WIFI:S:g;;"])).toBeNull();
  });
});

describe("describeScan", () => {
  it("shows what was read so an unknown label can be reported", () => {
    expect(describeScan(["SN:2TK44202X4"])).toBe("SN:2TK44202X4");
    expect(describeScan(["A", "B"])).toBe("A · B");
  });

  it("flattens newlines and truncates a long payload", () => {
    expect(describeScan(["AAA\n  BBB"])).toBe("AAA BBB");
    expect(describeScan(["X".repeat(50)])).toBe(`${"X".repeat(40)}…`);
  });

  it("caps how many it lists and counts the rest", () => {
    expect(describeScan(["A", "B", "C", "D"])).toBe("A · B (+2 more)");
  });
});

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

  // HP's service-label QR carries delimited KEY:VALUE fields, never a bare
  // serial — so testing the whole decoded string against SERIAL_SHAPE rejected
  // every HP tag as "Not an item code".
  it("reads the serial out of an HP field-string QR", () => {
    expect(parseScan("SN:2TK44202X4;PN:1AB23AV#ABA")).toEqual({ kind: "serial", serial: "2TK44202X4" });
  });

  // The real payload, read off an HP ProBook 650 G5's label (serial 2TK94709FN,
  // a live item). Not a KEY:VALUE string at all — a comma-separated list whose
  // first field is the bare serial. Also carries the device description.
  it("reads the serial out of HP's comma-separated label QR", () => {
    expect(parseScan("2TK94709FN, HP ProBook 650 G5, ProdID 5PF3AB#ABA"))
      .toEqual({
        kind: "serial",
        serial: "2TK94709FN",
        label: { make: "HP", model: "HP ProBook 650 G5" },
      });
  });

  // Only a WHOLE comma-separated field can be the serial, so a descriptive
  // field never contributes a fragment of itself.
  it("skips descriptive fields and takes the first that is a serial", () => {
    expect(parseScan("HP ProBook 650 G5, 2TK94709FN")).toEqual({ kind: "serial", serial: "2TK94709FN" });
  });

  it("accepts the common serial key spellings and both separators", () => {
    expect(parseScan("PN:1AB23AV;S/N:5CG0384PW1")).toEqual({ kind: "serial", serial: "5CG0384PW1" });
    expect(parseScan("SERIAL=2MQ5470PWC,PN=1AB23AV")).toEqual({ kind: "serial", serial: "2MQ5470PWC" });
    expect(parseScan("PN:1AB23AV SN:1H853859V0")).toEqual({ kind: "serial", serial: "1H853859V0" });
    expect(parseScan("SerialNumber:2TK0510GCB\nPartNumber:1AB23AV")).toEqual({ kind: "serial", serial: "2TK0510GCB" });
  });

  // The field parser must not become a "find any serial-shaped token" scan: the
  // Dell PPID below contains "0ABCDE", and a product number is shared across
  // thousands of units, so a loose match resolves the WRONG device.
  it("ignores fields that are not a serial", () => {
    expect(parseScan("PN:1AB23AV;MAC:00119F1A2B3C")).toBeNull();
    expect(parseScan("CN-0ABCDE-12345-ABC-1234-A00")).toBeNull();
    expect(parseScan("WIFI:S:guest;T:WPA;P:hunter2;;")).toBeNull();
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

  // HP's comma list carries a description in its second field, and the stored
  // row for this serial is make "HP" / model "HP ProBook 650 G5" — so the model
  // is the WHOLE field and the make is its first token.
  it("offers make and model from the label as a create hint", () => {
    expect(parseScan("2TK94709FN, HP ProBook 650 G5, ProdID 5PF3AB#ABA")).toEqual({
      kind: "serial",
      serial: "2TK94709FN",
      label: { make: "HP", model: "HP ProBook 650 G5" },
    });
  });

  // A hint is only ever a prefill. Nothing else may depend on it, so the shapes
  // that carry no description must not invent one.
  it("offers no hint for a bare serial or a keyed field string", () => {
    expect(parseScan("5CD1234ABC")).toEqual({ kind: "serial", serial: "5CD1234ABC" });
    expect(parseScan("SN:2TK44202X4;PN:1AB23AV")).toEqual({ kind: "serial", serial: "2TK44202X4" });
  });

  it("offers no hint when the description field is not a description", () => {
    // Second field is itself a serial, so there is no device description here.
    expect(parseScan("2TK94709FN, 5CD1234ABC")).toEqual({ kind: "serial", serial: "2TK94709FN" });
  });
});
