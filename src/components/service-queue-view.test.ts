import { describe, it, expect } from "vitest";
import {
  sortQueueRows,
  filterQueueRows,
  parseQueueSort,
  parseQueueHidden,
  QUEUE_COLUMNS,
  type QueueRowVM,
} from "./service-queue-view";

const rows: QueueRowVM[] = [
  { id: "1", itemId: "i1", serialNumber: "B2", deviceName: "Laptop-9", homeUnit: "A Co", serviceType: "Reimage", serviceTypeRaw: "REIMAGE" },
  { id: "2", itemId: "i2", serialNumber: "A1", deviceName: null, homeUnit: "B Co", serviceType: "cracked screen", serviceTypeRaw: "OTHER" },
  { id: "3", itemId: "i3", serialNumber: "C3", deviceName: "Tablet-1", homeUnit: null, serviceType: "Repair", serviceTypeRaw: "REPAIR" },
];

describe("sortQueueRows", () => {
  it("sorts by serial ascending and descending; unmutated input", () => {
    expect(sortQueueRows(rows, "serialNumber", "asc").map((r) => r.serialNumber)).toEqual(["A1", "B2", "C3"]);
    expect(sortQueueRows(rows, "serialNumber", "desc").map((r) => r.serialNumber)).toEqual(["C3", "B2", "A1"]);
    expect(rows[0].serialNumber).toBe("B2");
  });

  it("sorts blanks last regardless of direction", () => {
    expect(sortQueueRows(rows, "deviceName", "asc").map((r) => r.deviceName)).toEqual(["Laptop-9", "Tablet-1", null]);
    expect(sortQueueRows(rows, "deviceName", "desc").map((r) => r.deviceName)).toEqual(["Tablet-1", "Laptop-9", null]);
  });

  it("returns a copy in original order when field is null", () => {
    expect(sortQueueRows(rows, null, "asc").map((r) => r.id)).toEqual(["1", "2", "3"]);
  });
});

describe("filterQueueRows", () => {
  it("search matches SN, device name, or unit (case-insensitive)", () => {
    expect(filterQueueRows(rows, { search: "laptop", type: "ALL" }).map((r) => r.id)).toEqual(["1"]);
    expect(filterQueueRows(rows, { search: "b co", type: "ALL" }).map((r) => r.id)).toEqual(["2"]);
    expect(filterQueueRows(rows, { search: "a1", type: "ALL" }).map((r) => r.id)).toEqual(["2"]);
  });

  it("filters by service type using the raw enum", () => {
    expect(filterQueueRows(rows, { search: "", type: "OTHER" }).map((r) => r.id)).toEqual(["2"]);
    expect(filterQueueRows(rows, { search: "", type: "REIMAGE" }).map((r) => r.id)).toEqual(["1"]);
  });

  it("combines search and type", () => {
    expect(filterQueueRows(rows, { search: "c3", type: "REIMAGE" })).toEqual([]);
  });
});

describe("parse helpers", () => {
  it("parseQueueSort validates field + dir", () => {
    expect(parseQueueSort(JSON.stringify({ field: "homeUnit", dir: "desc" }))).toEqual({ field: "homeUnit", dir: "desc" });
    expect(parseQueueSort(JSON.stringify({ field: "bogus", dir: "asc" }))).toEqual({ field: null, dir: "asc" });
    expect(parseQueueSort(null)).toEqual({ field: null, dir: "asc" });
  });

  it("parseQueueHidden keeps known keys and never hides every column", () => {
    expect(parseQueueHidden(JSON.stringify(["deviceName", "homeUnit"]))).toEqual(["deviceName", "homeUnit"]);
    expect(parseQueueHidden(JSON.stringify(QUEUE_COLUMNS.map((c) => c.key)))).toEqual([]);
    expect(parseQueueHidden(JSON.stringify(["nope"]))).toEqual([]);
  });
});
