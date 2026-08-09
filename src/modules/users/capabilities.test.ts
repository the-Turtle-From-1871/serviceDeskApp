import { describe, expect, test } from "vitest";
import {
  CAPABILITIES,
  CAPABILITY_LABELS,
  effectiveCapabilities,
  isElevated,
  isRequestable,
  roleBaseline,
} from "./capabilities";

describe("roleBaseline", () => {
  test("VIEWER can only read inventory", () => {
    expect(roleBaseline("VIEWER")).toEqual(["VIEW_INVENTORY"]);
  });

  // These four ARE today's USER rights. If this test needs changing, the
  // migration is changing what existing accounts can do — which it must not.
  test("USER keeps exactly today's rights", () => {
    expect(roleBaseline("USER")).toEqual([
      "VIEW_INVENTORY",
      "VIEW_ALL_RECEIPTS",
      "CREATE_RECEIPTS",
      "EDIT_ITEM_HOLDER",
    ]);
  });

  test("ADMIN holds every capability", () => {
    expect(roleBaseline("ADMIN")).toEqual([...CAPABILITIES]);
  });
});

describe("effectiveCapabilities", () => {
  test("adds a grant to the role baseline", () => {
    expect(effectiveCapabilities("VIEWER", ["CREATE_RECEIPTS"])).toEqual([
      "VIEW_INVENTORY",
      "CREATE_RECEIPTS",
    ]);
  });

  test("de-duplicates a grant that the baseline already covers", () => {
    expect(effectiveCapabilities("USER", ["CREATE_RECEIPTS"])).toEqual(roleBaseline("USER"));
  });

  test("returns capabilities in canonical order regardless of grant order", () => {
    const a = effectiveCapabilities("VIEWER", ["ADMINISTER", "CREATE_RECEIPTS"]);
    const b = effectiveCapabilities("VIEWER", ["CREATE_RECEIPTS", "ADMINISTER"]);
    expect(a).toEqual(b);
    expect(a).toEqual(["VIEW_INVENTORY", "CREATE_RECEIPTS", "ADMINISTER"]);
  });

  test("a grant can never remove a baseline capability", () => {
    expect(effectiveCapabilities("ADMIN", [])).toEqual([...CAPABILITIES]);
  });

  test("does not mutate its arguments", () => {
    const grants: ["CREATE_RECEIPTS"] = ["CREATE_RECEIPTS"];
    effectiveCapabilities("VIEWER", grants);
    expect(grants).toEqual(["CREATE_RECEIPTS"]);
  });
});

describe("classification", () => {
  test("ADMINISTER is the only elevated capability", () => {
    expect(CAPABILITIES.filter(isElevated)).toEqual(["ADMINISTER"]);
  });

  test("VIEW_INVENTORY is not requestable because everyone has it", () => {
    expect(isRequestable("VIEW_INVENTORY")).toBe(false);
  });

  test("ADMINISTER is requestable, elevated but not forbidden", () => {
    expect(isRequestable("ADMINISTER")).toBe(true);
  });

  test("every capability has a human label", () => {
    for (const c of CAPABILITIES) {
      expect(CAPABILITY_LABELS[c]).toBeTruthy();
    }
  });
});
