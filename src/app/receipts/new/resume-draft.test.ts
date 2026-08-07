import { describe, it, expect } from "vitest";
import { splitDraftItems, formatDroppedItemsNotice } from "@/modules/receipts/drafts.resume";

const loaded = (ids: string[]) => ids.map((id) => ({ id }));

describe("splitDraftItems", () => {
  it("keeps items that are still loadable, in the draft's original order", () => {
    expect(splitDraftItems(["a", "b", "c"], loaded(["c", "a", "b"]))).toEqual({
      keptIds: ["a", "b", "c"],
      droppedIds: [],
    });
  });

  it("drops items that no longer load (deleted or retired)", () => {
    expect(splitDraftItems(["a", "b", "c"], loaded(["a", "c"]))).toEqual({
      keptIds: ["a", "c"],
      droppedIds: ["b"],
    });
  });

  it("reports everything dropped when nothing survives", () => {
    expect(splitDraftItems(["a", "b"], loaded([]))).toEqual({ keptIds: [], droppedIds: ["a", "b"] });
  });

  it("handles an empty draft", () => {
    expect(splitDraftItems([], loaded([]))).toEqual({ keptIds: [], droppedIds: [] });
  });
});

// Finding 5 (design spec §4): the banner must NAME what it can — serial and
// make/model of a retired item — and still ACCOUNT FOR what it can't (an id
// that resolves to no row at all: deleted outright, not merely retired).
describe("formatDroppedItemsNotice", () => {
  it("returns an empty string for nothing dropped", () => {
    expect(formatDroppedItemsNotice([])).toBe("");
  });

  it("names a single retired device by serial and make/model", () => {
    const notice = formatDroppedItemsNotice([{ id: "i1", serialNumber: "ABC123", make: "Dell", model: "Latitude 5420" }]);
    expect(notice).toBe("SN ABC123 (Dell Latitude 5420) was retired and has been removed from this draft.");
  });

  it("lists several retired devices and uses plural grammar", () => {
    const notice = formatDroppedItemsNotice([
      { id: "i1", serialNumber: "ABC123", make: "Dell", model: "Latitude 5420" },
      { id: "i2", serialNumber: "XYZ789", make: "HP", model: "EliteBook 840" },
    ]);
    expect(notice).toBe(
      "SN ABC123 (Dell Latitude 5420) and SN XYZ789 (HP EliteBook 840) were retired and have been removed from this draft.",
    );
  });

  it("does not invent an identifier for a device deleted outright — it counts it instead", () => {
    const notice = formatDroppedItemsNotice([{ id: "i1" }]);
    expect(notice).toBe("1 device from this draft is no longer in inventory and has been removed.");
    expect(notice).not.toContain("i1"); // the raw id is not a name — never surfaced
  });

  it("pluralizes the unnameable-only case for more than one", () => {
    const notice = formatDroppedItemsNotice([{ id: "i1" }, { id: "i2" }]);
    expect(notice).toBe("2 devices from this draft are no longer in inventory and have been removed.");
  });

  it("names the nameable ones AND still accounts for the unnameable ones in a mixed drop", () => {
    const notice = formatDroppedItemsNotice([
      { id: "i1", serialNumber: "ABC123", make: "Dell", model: "Latitude 5420" },
      { id: "i2" },
    ]);
    expect(notice).toBe(
      "SN ABC123 (Dell Latitude 5420) was retired and has been removed from this draft, and 1 device no longer in inventory.",
    );
  });
});
