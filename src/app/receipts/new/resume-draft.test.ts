import { describe, it, expect } from "vitest";
import { splitDraftItems } from "@/modules/receipts/drafts.resume";

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
