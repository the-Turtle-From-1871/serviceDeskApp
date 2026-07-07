import { describe, it, expect } from "vitest";
import { groupItemsIntoLines, buildItemSummary, MAX_RECEIPT_ROWS } from "./receipt-lines";

const item = (itemId: string, make: string, model: string, serialNumber: string) =>
  ({ itemId, make, model, serialNumber });

describe("groupItemsIntoLines", () => {
  it("merges same make+model into one row and keeps different items separate", () => {
    const lines = groupItemsIntoLines([
      item("i1", "M4", "Carbine", "A1"),
      item("i2", "M4", "Carbine", "A2"),
      item("i3", "AN/PVS", "14", "B7"),
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ lineNo: 1, make: "M4", model: "Carbine", serials: ["A1", "A2"], itemIds: ["i1", "i2"], defaultQty: 2, unitOfIssue: "EA" });
    expect(lines[1]).toMatchObject({ lineNo: 2, make: "AN/PVS", model: "14", serials: ["B7"], defaultQty: 1 });
  });

  it("assigns lineNo in first-seen order", () => {
    const lines = groupItemsIntoLines([
      item("i1", "B", "b", "s1"),
      item("i2", "A", "a", "s2"),
      item("i3", "B", "b", "s3"),
    ]);
    expect(lines.map((l) => `${l.make}#${l.lineNo}`)).toEqual(["B#1", "A#2"]);
  });
});

describe("buildItemSummary", () => {
  it("summarizes a single-line receipt as make model (SN x)", () => {
    expect(buildItemSummary([{ make: "M4", model: "Carbine", serials: ["A1"] }])).toBe("M4 Carbine (SN A1)");
  });
  it("appends +N more when a line has extra serials or more lines exist", () => {
    expect(buildItemSummary([
      { make: "M4", model: "Carbine", serials: ["A1", "A2"] },
      { make: "AN/PVS", model: "14", serials: ["B7"] },
    ])).toBe("M4 Carbine (SN A1) +2 more");
  });
});

describe("MAX_RECEIPT_ROWS", () => {
  it("is 18", () => expect(MAX_RECEIPT_ROWS).toBe(18));
});
