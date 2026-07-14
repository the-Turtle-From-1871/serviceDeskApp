import { describe, it, expect } from "vitest";
import {
  sortItemRows,
  parseSortPref,
  parseHiddenCols,
  selectableIds,
  selectAllState,
  ITEM_COLUMNS,
  type ItemRow,
} from "./items-view";

const row = (over: Partial<ItemRow>): ItemRow => ({
  id: over.id ?? Math.random().toString(),
  deviceName: over.deviceName ?? null,
  make: over.make ?? "",
  model: over.model ?? "",
  serialNumber: over.serialNumber ?? "",
  status: over.status ?? "ACTIVE",
});

describe("sortItemRows", () => {
  it("sorts by a field ascending, case-insensitively", () => {
    const rows = [row({ make: "banana" }), row({ make: "Apple" }), row({ make: "cherry" })];
    expect(sortItemRows(rows, "make", "asc").map((r) => r.make)).toEqual(["Apple", "banana", "cherry"]);
  });

  it("descending reverses the order", () => {
    const rows = [row({ make: "banana" }), row({ make: "Apple" }), row({ make: "cherry" })];
    expect(sortItemRows(rows, "make", "desc").map((r) => r.make)).toEqual(["cherry", "banana", "Apple"]);
  });

  it("preserves original order when field is null", () => {
    const rows = [row({ make: "banana" }), row({ make: "Apple" })];
    expect(sortItemRows(rows, null, "asc").map((r) => r.make)).toEqual(["banana", "Apple"]);
  });

  it("sorts null/blank values last regardless of direction", () => {
    const rows = [row({ id: "a", deviceName: null }), row({ id: "b", deviceName: "Zebra" }), row({ id: "c", deviceName: "" }), row({ id: "d", deviceName: "Alpha" })];
    expect(sortItemRows(rows, "deviceName", "asc").map((r) => r.id)).toEqual(["d", "b", "a", "c"]);
    expect(sortItemRows(rows, "deviceName", "desc").map((r) => r.id)).toEqual(["b", "d", "a", "c"]);
  });

  it("does not mutate the input array", () => {
    const rows = [row({ make: "b" }), row({ make: "a" })];
    const before = rows.slice();
    sortItemRows(rows, "make", "asc");
    expect(rows).toEqual(before);
  });
});

describe("parseSortPref", () => {
  it("parses a valid stored preference", () => {
    expect(parseSortPref(JSON.stringify({ field: "make", dir: "desc" }))).toEqual({ field: "make", dir: "desc" });
  });

  it("falls back to default on invalid JSON", () => {
    expect(parseSortPref("not json")).toEqual({ field: null, dir: "asc" });
  });

  it("rejects an unknown field", () => {
    expect(parseSortPref(JSON.stringify({ field: "hacker", dir: "asc" }))).toEqual({ field: null, dir: "asc" });
  });

  it("rejects an unknown direction", () => {
    expect(parseSortPref(JSON.stringify({ field: "make", dir: "sideways" }))).toEqual({ field: null, dir: "asc" });
  });

  it("handles null input", () => {
    expect(parseSortPref(null)).toEqual({ field: null, dir: "asc" });
  });
});

describe("parseHiddenCols", () => {
  it("keeps only valid column keys", () => {
    expect(parseHiddenCols(JSON.stringify(["make", "bogus", "status"]))).toEqual(["make", "status"]);
  });

  it("falls back to empty on garbage", () => {
    expect(parseHiddenCols("{}")).toEqual([]);
    expect(parseHiddenCols(null)).toEqual([]);
  });

  it("never hides every data column", () => {
    const all = ITEM_COLUMNS.map((c) => c.key);
    expect(parseHiddenCols(JSON.stringify(all))).toEqual([]);
  });
});

describe("selectableIds", () => {
  it("returns only active rows — retired rows have no checkbox", () => {
    const rows = [
      row({ id: "a", status: "ACTIVE" }),
      row({ id: "b", status: "RETIRED" }),
      row({ id: "c", status: "ACTIVE" }),
    ];
    expect(selectableIds(rows)).toEqual(["a", "c"]);
  });

  it("returns empty for an empty or fully retired list", () => {
    expect(selectableIds([])).toEqual([]);
    expect(selectableIds([row({ id: "a", status: "RETIRED" })])).toEqual([]);
  });
});

describe("selectAllState", () => {
  const rows = [
    row({ id: "a", status: "ACTIVE" }),
    row({ id: "b", status: "RETIRED" }),
    row({ id: "c", status: "ACTIVE" }),
  ];

  it("is none when nothing is selected", () => {
    expect(selectAllState(rows, new Set())).toBe("none");
  });

  it("is some when only part of the active rows are selected", () => {
    expect(selectAllState(rows, new Set(["a"]))).toBe("some");
  });

  it("is all once every active row is selected, ignoring retired rows", () => {
    expect(selectAllState(rows, new Set(["a", "c"]))).toBe("all");
  });

  it("is none when there is nothing selectable at all", () => {
    expect(selectAllState([], new Set())).toBe("none");
    expect(selectAllState([row({ id: "b", status: "RETIRED" })], new Set(["b"]))).toBe("none");
  });

  it("ignores selected ids that are not in the list", () => {
    expect(selectAllState(rows, new Set(["a", "c", "ghost"]))).toBe("all");
    expect(selectAllState(rows, new Set(["ghost"]))).toBe("none");
  });
});
