import { describe, it, expect } from "vitest";
import { toCsv, exportName } from "./export";

describe("toCsv", () => {
  it("writes a header even with no rows", () => {
    expect(toCsv(["Date", "Count"], [])).toBe("Date,Count");
  });

  it("emits CRLF line endings per RFC 4180", () => {
    const csv = toCsv(["a"], [{ a: 1 }, { a: 2 }]);
    expect(csv).toBe("a\r\n1\r\n2");
  });

  it("quotes a field containing a comma", () => {
    // The real case: a device name like "LAPTOP, B CO" must not split into
    // two columns when the file is opened in Excel.
    expect(toCsv(["name"], [{ name: "LAPTOP, B CO" }])).toBe('name\r\n"LAPTOP, B CO"');
  });

  it("doubles embedded quotes", () => {
    expect(toCsv(["name"], [{ name: 'A "B" C' }])).toBe('name\r\n"A ""B"" C"');
  });

  it("quotes a field containing a newline", () => {
    expect(toCsv(["note"], [{ note: "line1\nline2" }])).toBe('note\r\n"line1\nline2"');
  });

  it("renders null and undefined as empty, not as the words", () => {
    expect(toCsv(["a", "b"], [{ a: null, b: undefined }])).toBe("a,b\r\n,");
  });

  it("emits an empty cell for a column missing from a row", () => {
    expect(toCsv(["a", "b"], [{ a: 1 }])).toBe("a,b\r\n1,");
  });

  it("writes columns in the requested order, ignoring key order", () => {
    expect(toCsv(["b", "a"], [{ a: 1, b: 2 }])).toBe("b,a\r\n2,1");
  });

  it("preserves zero rather than blanking it", () => {
    // A falsy-but-meaningful value: "0 items deployed" is data, not absence.
    expect(toCsv(["n"], [{ n: 0 }])).toBe("n\r\n0");
  });

  // Category/device names originate from CSV import, i.e. from outside, so
  // they can carry a spreadsheet formula into an admin's export.
  it("neutralises a leading = so Excel treats it as text", () => {
    expect(toCsv(["c"], [{ c: '=HYPERLINK("http://evil/","x")' }])).toBe(
      'c\r\n"\'=HYPERLINK(""http://evil/"",""x"")"',
    );
  });

  it.each(["=cmd", "+1+1", "@SUM(A1)", "\tx", "\rx"])("neutralises the leading char in %j", (v) => {
    const body = toCsv(["c"], [{ c: v }]).split("\r\n")[1];
    // Either bare-prefixed or quoted-and-prefixed, depending on the payload.
    expect(body.replace(/^"|"$/g, "").startsWith("'")).toBe(true);
  });

  it("does NOT mangle a negative number", () => {
    expect(toCsv(["n"], [{ n: -5 }])).toBe("n\r\n-5");
    expect(toCsv(["n"], [{ n: -5.25 }])).toBe("n\r\n-5.25");
  });

  it("leaves an ordinary label untouched", () => {
    expect(toCsv(["c"], [{ c: "Laptops" }])).toBe("c\r\nLaptops");
  });
});

describe("exportName", () => {
  it("slugs the base and parts together", () => {
    expect(exportName("fleet-status", ["30d", "W6BTAA"], "csv")).toBe("fleet-status-30d-w6btaa.csv");
  });

  it("drops null/undefined parts", () => {
    expect(exportName("audit", [null, undefined, "all-units"], "png")).toBe("audit-all-units.png");
  });

  it("collapses punctuation and trims stray separators", () => {
    expect(exportName("DA Form 2062!", ["1y"], "csv")).toBe("da-form-2062-1y.csv");
  });
});
