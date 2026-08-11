import { describe, it, expect } from "vitest";
import { parseSelection, EMPTY_SELECTION } from "./item-selection-store";

const ok = { id: "a1", make: "Dell", model: "5540", serialNumber: "7XK2Q13", status: "ACTIVE" };

describe("parseSelection", () => {
  it("returns the empty selection for null", () => {
    expect(parseSelection(null)).toEqual(EMPTY_SELECTION);
  });

  it("returns the empty selection for malformed JSON rather than throwing", () => {
    expect(parseSelection("{not json")).toEqual(EMPTY_SELECTION);
  });

  it("returns the empty selection when items is not an array", () => {
    expect(parseSelection(JSON.stringify({ startedAt: 1, items: "nope" }))).toEqual(EMPTY_SELECTION);
  });

  it("round-trips a valid selection", () => {
    const raw = JSON.stringify({ startedAt: 1754870000000, items: [ok] });
    expect(parseSelection(raw)).toEqual({ startedAt: 1754870000000, items: [ok] });
  });

  it("drops entries that are not well-formed SelectedItems", () => {
    const raw = JSON.stringify({
      startedAt: 5,
      items: [ok, { id: "b2" }, null, { ...ok, id: "", }, { ...ok, id: "c3", status: "GONE" }],
    });
    expect(parseSelection(raw)).toEqual({ startedAt: 5, items: [ok] });
  });

  it("falls back to 0 for a non-finite startedAt", () => {
    const raw = JSON.stringify({ startedAt: "yesterday", items: [ok] });
    expect(parseSelection(raw).startedAt).toBe(0);
  });
});
