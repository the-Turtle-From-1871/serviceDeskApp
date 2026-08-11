import { describe, it, expect } from "vitest";
import { parseSelection, EMPTY_SELECTION } from "./item-selection-store";
import { MAX_BULK_ITEMS } from "@/modules/items/items.schema";

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

  it("caps a forged over-long array at MAX_BULK_ITEMS, keeping the first ones", () => {
    const items = Array.from({ length: MAX_BULK_ITEMS + 25 }, (_, i) => ({ ...ok, id: `id-${i}` }));
    const parsed = parseSelection(JSON.stringify({ startedAt: 1, items }));
    expect(parsed.items).toHaveLength(MAX_BULK_ITEMS);
    expect(parsed.items[0].id).toBe("id-0");
    expect(parsed.items[MAX_BULK_ITEMS - 1].id).toBe(`id-${MAX_BULK_ITEMS - 1}`);
  });

  it("counts the cap AFTER dropping malformed entries", () => {
    const items = [
      { id: "bad" },
      ...Array.from({ length: MAX_BULK_ITEMS }, (_, i) => ({ ...ok, id: `id-${i}` })),
    ];
    // The malformed entry must not consume a slot, or a single bad row silently
    // costs a real device its place in the batch.
    expect(parseSelection(JSON.stringify({ startedAt: 1, items })).items).toHaveLength(MAX_BULK_ITEMS);
  });

  it("falls back to 0 for a non-finite startedAt", () => {
    const raw = JSON.stringify({ startedAt: "yesterday", items: [ok] });
    expect(parseSelection(raw).startedAt).toBe(0);
  });
});
