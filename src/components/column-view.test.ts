import { describe, it, expect } from "vitest";
import { sortRows, parseSortPref, parseHiddenCols } from "./column-view";

type R = { id: string; name: string | null };
const fields = new Set(["name", "code"]);
const rows: R[] = [{ id: "b", name: "banana" }, { id: "a", name: "Apple" }, { id: "z", name: null }];

describe("sortRows", () => {
  it("sorts case-insensitively; blanks last both directions; no mutation", () => {
    const before = rows.slice();
    expect(sortRows(rows, "name", "asc").map((r) => r.id)).toEqual(["a", "b", "z"]);
    expect(sortRows(rows, "name", "desc").map((r) => r.id)).toEqual(["b", "a", "z"]);
    expect(sortRows(rows, null, "asc").map((r) => r.id)).toEqual(["b", "a", "z"]);
    expect(rows).toEqual(before);
  });
});

describe("parseSortPref", () => {
  it("validates field against the allowed set and requires a real direction", () => {
    expect(parseSortPref(JSON.stringify({ field: "name", dir: "desc" }), fields)).toEqual({ field: "name", dir: "desc" });
    expect(parseSortPref(JSON.stringify({ field: "hacker", dir: "asc" }), fields)).toEqual({ field: null, dir: "asc" });
    expect(parseSortPref(JSON.stringify({ field: "name", dir: "sideways" }), fields)).toEqual({ field: null, dir: "asc" });
    expect(parseSortPref("not json", fields)).toEqual({ field: null, dir: "asc" });
    expect(parseSortPref(null, fields)).toEqual({ field: null, dir: "asc" });
  });
});

describe("parseHiddenCols", () => {
  it("keeps known keys and never hides every column", () => {
    expect(parseHiddenCols(JSON.stringify(["name", "bogus"]), fields, 2)).toEqual(["name"]);
    expect(parseHiddenCols(JSON.stringify(["name", "code"]), fields, 2)).toEqual([]);
    expect(parseHiddenCols("{}", fields, 2)).toEqual([]);
    expect(parseHiddenCols(null, fields, 2)).toEqual([]);
  });
});
