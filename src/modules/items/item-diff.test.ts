import { describe, it, expect } from "vitest";
import { diffItemFields } from "./item-diff";

describe("diffItemFields", () => {
  it("returns only the fields that actually changed", () => {
    expect(
      diffItemFields(
        { deviceName: "L-1", homeUnit: "A Co", currentUser: null },
        { deviceName: "L-2", homeUnit: "A Co" },
      ),
    ).toEqual([{ field: "deviceName", from: "L-1", to: "L-2" }]);
  });

  it("is empty for a no-op save", () => {
    expect(diffItemFields({ deviceName: "L-1" }, { deviceName: "L-1" })).toEqual([]);
  });

  it("ignores keys absent from `after` — that is not a clear-to-null", () => {
    expect(diffItemFields({ deviceName: "L-1", notes: "keep" }, { deviceName: "L-1" })).toEqual([]);
  });

  it("skips keys explicitly set to undefined in `after`", () => {
    expect(diffItemFields({ deviceName: "L-1" }, { deviceName: undefined })).toEqual([]);
  });

  it("treats blank, whitespace and null as equivalent (no change)", () => {
    expect(diffItemFields({ currentUser: null }, { currentUser: "   " })).toEqual([]);
    expect(diffItemFields({ currentUser: "" }, { currentUser: null })).toEqual([]);
  });

  it("trims before comparing and records the trimmed value", () => {
    expect(
      diffItemFields({ currentUser: "SGT Smith" }, { currentUser: "  SGT Jones  " }),
    ).toEqual([{ field: "currentUser", from: "SGT Smith", to: "SGT Jones" }]);
  });

  it("records a clear-to-null when the new value is blank", () => {
    expect(
      diffItemFields({ currentPosition: "Supply Sergeant" }, { currentPosition: "" }),
    ).toEqual([{ field: "currentPosition", from: "Supply Sergeant", to: null }]);
  });

  it("records multiple changes", () => {
    expect(
      diffItemFields(
        { currentUser: null, currentPosition: null },
        { currentUser: "SPC Lin", currentPosition: "S6" },
      ),
    ).toEqual([
      { field: "currentUser", from: null, to: "SPC Lin" },
      { field: "currentPosition", from: null, to: "S6" },
    ]);
  });
});
