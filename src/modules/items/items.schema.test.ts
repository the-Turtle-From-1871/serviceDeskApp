import { describe, it, expect } from "vitest";
import { itemDetailsSchema } from "./items.schema";

const base = { deviceName: "Laptop-9", homeUnit: "A Co", currentUser: "SGT Smith", currentPosition: "Supply" };

describe("itemDetailsSchema", () => {
  it("accepts the four fields and trims them", () => {
    const parsed = itemDetailsSchema.parse({ ...base, currentUser: "  SGT Smith  " });
    expect(parsed.currentUser).toBe("SGT Smith");
  });

  it("KEEPS blank values so they can clear a stored field", () => {
    // Regression guard: the `optional` helper used by newItemSchema drops "" to
    // undefined, which diffItemFields would skip — clearing would silently no-op.
    const parsed = itemDetailsSchema.parse({ ...base, currentUser: "", currentPosition: "   " });
    expect(parsed.currentUser).toBe("");
    expect(parsed.currentPosition).toBe("");
  });

  it("requires a device name", () => {
    expect(itemDetailsSchema.safeParse({ ...base, deviceName: "  " }).success).toBe(false);
  });
});
