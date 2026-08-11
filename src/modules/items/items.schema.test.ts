import { describe, it, expect } from "vitest";
import {
  itemDetailsSchema,
  adminItemEditSchema,
  userItemDetailsSchema,
  newItemSchema,
  scannedItemSchema,
  MAX_CATEGORY_NAME,
} from "./items.schema";

// The eight — and only eight — fields both edit surfaces expose.
const EDITABLE_FIELDS = [
  "deviceName",
  "homeUnit",
  "deviceUIC",
  "currentUserEmail",
  "currentPosition",
  "notes",
  "deviceCategory",
  "storageLocation",
] as const;

const base = {
  deviceName: "Laptop-9",
  homeUnit: "A Co",
  deviceUIC: "WABC01",
  currentUserEmail: "SGT Smith",
  currentPosition: "Supply",
  notes: "Screen scratched",
  deviceCategory: "Laptop",
  storageLocation: "Bldg 400 Cage 3",
};

// Both surfaces share ONE field definition, so run one suite over both.
const surfaces = [
  ["itemDetailsSchema (item detail card, ADMIN branch)", itemDetailsSchema],
  ["adminItemEditSchema (/admin/items/[id]/edit)", adminItemEditSchema],
] as const;

describe.each(surfaces)("%s", (_name, schema) => {
  it("round-trips all eight editable fields", () => {
    const parsed = schema.parse(base);
    expect(parsed).toEqual(base);
    expect(Object.keys(parsed).sort()).toEqual([...EDITABLE_FIELDS].sort());
  });

  it("trims each field", () => {
    const parsed = schema.parse({ ...base, currentUserEmail: "  SGT Smith  ", notes: "  hi  " });
    expect(parsed.currentUserEmail).toBe("SGT Smith");
    expect(parsed.notes).toBe("hi");
  });

  it("KEEPS blank values so they can clear a stored field", () => {
    // Regression guard: the `optional` helper used by newItemSchema drops "" to
    // undefined, which diffItemFields would skip — clearing would silently no-op.
    const parsed = schema.parse({
      ...base,
      homeUnit: "",
      deviceUIC: "  ",
      currentUserEmail: "",
      currentPosition: "   ",
      notes: "",
      deviceCategory: "   ",
      storageLocation: "  ",
    });
    expect(parsed.homeUnit).toBe("");
    expect(parsed.deviceUIC).toBe("");
    expect(parsed.currentUserEmail).toBe("");
    expect(parsed.currentPosition).toBe("");
    expect(parsed.notes).toBe("");
    // A blank category CLEARS it — categoryOptional (import) would drop this to
    // undefined, which reads as "not submitted".
    expect(parsed.deviceCategory).toBe("");
    expect(parsed.storageLocation).toBe("");
  });

  it("requires a device name (it backs a NOT NULL column)", () => {
    expect(schema.safeParse({ ...base, deviceName: "  " }).success).toBe(false);
  });

  it("normalizes the category to the vocabulary's canonical form", () => {
    const parsed = schema.parse({ ...base, deviceCategory: "  Tough   Book " });
    expect(parsed.deviceCategory).toBe("Tough Book");
  });

  it("REJECTS an over-long category rather than silently dropping it", () => {
    const res = schema.safeParse({ ...base, deviceCategory: "x".repeat(MAX_CATEGORY_NAME + 1) });
    expect(res.success).toBe(false);
  });

  it("strips make/model/serialNumber — item identity is not editable here", () => {
    const parsed = schema.parse({ ...base, make: "Dell", model: "5420", serialNumber: "SN-HACK" });
    expect(parsed).not.toHaveProperty("make");
    expect(parsed).not.toHaveProperty("model");
    expect(parsed).not.toHaveProperty("serialNumber");
  });
});

describe("userItemDetailsSchema", () => {
  it("stays narrow: ONLY currentUserEmail + currentPosition survive", () => {
    const parsed = userItemDetailsSchema.parse(base);
    expect(parsed).toEqual({ currentUserEmail: "SGT Smith", currentPosition: "Supply" });
    for (const f of ["deviceName", "homeUnit", "deviceUIC", "notes", "deviceCategory", "storageLocation"]) {
      expect(parsed).not.toHaveProperty(f);
    }
  });

  it("KEEPS blanks so a USER can clear the holder", () => {
    const parsed = userItemDetailsSchema.parse({ currentUserEmail: "  ", currentPosition: "" });
    expect(parsed).toEqual({ currentUserEmail: "", currentPosition: "" });
  });
});

import { itemIdentitySchema } from "./items.schema";

describe("itemIdentitySchema (admin edit page's separate identity form)", () => {
  const identity = { make: "Dell", model: "Latitude 5420", serialNumber: "ABC123" };

  it("round-trips exactly make/model/serialNumber", () => {
    const parsed = itemIdentitySchema.parse(identity);
    expect(parsed).toEqual(identity);
    expect(Object.keys(parsed).sort()).toEqual(["make", "model", "serialNumber"]);
  });

  it("trims each field", () => {
    const parsed = itemIdentitySchema.parse({
      make: "  Dell  ",
      model: "  5420 ",
      serialNumber: "  ABC123  ",
    });
    expect(parsed).toEqual({ make: "Dell", model: "5420", serialNumber: "ABC123" });
  });

  it("preserves case — serialNumber is citext, so a case-only correction is a real edit", () => {
    expect(itemIdentitySchema.parse({ ...identity, serialNumber: "abc123" }).serialNumber).toBe("abc123");
  });

  it.each(["make", "model", "serialNumber"])(
    "REQUIRES a non-blank %s (all three back NOT NULL columns)",
    (field) => {
      expect(itemIdentitySchema.safeParse({ ...identity, [field]: "  " }).success).toBe(false);
      const missing = { ...identity } as Record<string, string>;
      delete missing[field];
      expect(itemIdentitySchema.safeParse(missing).success).toBe(false);
    },
  );

  it("strips the eight editable fields — this form corrects identity ONLY", () => {
    const parsed = itemIdentitySchema.parse({ ...identity, ...base });
    expect(parsed).toEqual(identity);
    for (const f of EDITABLE_FIELDS) expect(parsed).not.toHaveProperty(f);
  });
});

import { importRowSchema } from "./items.schema";

describe("importRowSchema", () => {
  it("requires only serialNumber; blanks become undefined", () => {
    const r = importRowSchema.parse({ serialNumber: "A1", make: "", assignedUser: "  " });
    expect(r.serialNumber).toBe("A1");
    expect(r.make).toBeUndefined();
    expect(r.assignedUser).toBeUndefined();
  });

  it("rejects a blank serialNumber", () => {
    const res = importRowSchema.safeParse({ serialNumber: "   " });
    expect(res.success).toBe(false);
  });

  it("keeps provided telemetry values", () => {
    const r = importRowSchema.parse({ serialNumber: "A1", compliance: "Compliant", lastLogonDate: "2026-07-01" });
    expect(r.compliance).toBe("Compliant");
    expect(r.lastLogonDate).toBe("2026-07-01");
  });
});

describe("newItemSchema — deviceUIC and deviceCategory", () => {
  const base = { make: "Dell", model: "5540", serialNumber: "ABC123", deviceName: "LT-01" };

  it("retains deviceUIC and deviceCategory instead of stripping them", () => {
    const parsed = newItemSchema.parse({ ...base, deviceUIC: "WABC01", deviceCategory: "Laptop" });
    expect(parsed.deviceUIC).toBe("WABC01");
    expect(parsed.deviceCategory).toBe("Laptop");
  });

  it("normalizes a category's internal whitespace and trims it", () => {
    const parsed = newItemSchema.parse({ ...base, deviceCategory: "  Docking   Station  " });
    expect(parsed.deviceCategory).toBe("Docking Station");
  });

  it("maps a blank category to undefined rather than an empty string", () => {
    const parsed = newItemSchema.parse({ ...base, deviceCategory: "   " });
    expect(parsed.deviceCategory).toBeUndefined();
  });

  it("REJECTS an over-long category with a message instead of silently dropping it", () => {
    const result = newItemSchema.safeParse({ ...base, deviceCategory: "x".repeat(MAX_CATEGORY_NAME + 1) });
    expect(result.success).toBe(false);
    expect(result.error!.issues[0]!.message).toMatch(/limited to 60 characters/);
  });

  // createItem re-parses its own input at the service boundary, so the schema
  // must accept its own output. Without the trailing .optional() on categoryNew,
  // a blank category becomes undefined on the first parse and fails z.string()
  // on the second — i.e. EVERY create without a category would break.
  it("round-trips its own output when the category is blank", () => {
    const once = newItemSchema.parse({ ...base, deviceCategory: "" });
    expect(() => newItemSchema.parse(once)).not.toThrow();
  });

  it("rejects a serial longer than the bound", () => {
    const result = newItemSchema.safeParse({ ...base, serialNumber: "x".repeat(65) });
    expect(result.success).toBe(false);
    expect(result.error!.issues[0]!.message).toMatch(/64 characters/);
  });

  it("still accepts a realistic serial", () => {
    expect(newItemSchema.parse({ ...base, serialNumber: "5CG1234ABC" }).serialNumber).toBe("5CG1234ABC");
  });
});

describe("storageLocation across the three schemas", () => {
  it("keeps a blank as \"\" on the edit schema, so emptying the box CLEARS it", () => {
    const parsed = adminItemEditSchema.parse({
      deviceName: "N1", homeUnit: "", deviceUIC: "", currentUserEmail: "",
      currentPosition: "", notes: "", deviceCategory: "", storageLocation: "  ",
    });
    expect(parsed.storageLocation).toBe("");
  });

  it("maps a blank to undefined on the import schema, so it leaves the stored value alone", () => {
    const parsed = importRowSchema.parse({ serialNumber: "ABC123", storageLocation: "  " });
    expect(parsed.storageLocation).toBeUndefined();
  });

  it("maps a blank to undefined on the create schema", () => {
    const parsed = newItemSchema.parse({
      make: "Dell", model: "5540", serialNumber: "ABC123", deviceName: "N1", storageLocation: "",
    });
    expect(parsed.storageLocation).toBeUndefined();
  });

  it("trims a real value on every one of them", () => {
    expect(importRowSchema.parse({ serialNumber: "A", storageLocation: " Bldg 400 " }).storageLocation).toBe("Bldg 400");
    expect(newItemSchema.parse({ make: "D", model: "5", serialNumber: "A", deviceName: "N", storageLocation: " Bldg 400 " }).storageLocation).toBe("Bldg 400");
  });
});

describe("scannedItemSchema", () => {
  const base = { make: "HP", model: "HP ProBook 650 G5", serialNumber: "2TK94709FN" };

  it("accepts a scanned item with no device name", () => {
    expect(scannedItemSchema.parse(base)).toMatchObject(base);
  });

  it("still requires make, model and serial", () => {
    expect(scannedItemSchema.safeParse({ ...base, make: "" }).success).toBe(false);
    expect(scannedItemSchema.safeParse({ ...base, serialNumber: "" }).success).toBe(false);
  });

  // The ONLY difference from newItemSchema. Derived with .extend(), never
  // restated — a restated field list is exactly the drift CLAUDE.md warns of.
  it("differs from newItemSchema in deviceName alone", () => {
    expect(newItemSchema.safeParse(base).success).toBe(false);          // needs deviceName
    expect(newItemSchema.safeParse({ ...base, deviceName: "X" }).success).toBe(true);
    expect(Object.keys(scannedItemSchema.shape).sort())
      .toEqual(Object.keys(newItemSchema.shape).sort());
  });
});
