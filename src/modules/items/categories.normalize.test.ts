import { describe, it, expect } from "vitest";
import { normalizeCategoryName } from "./categories.service";

// Normalization is what stops the curated list degenerating into near-duplicate
// rows ("Laptops", "Laptops ", "Laptops  Docked").
describe("normalizeCategoryName", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeCategoryName("  Laptops  ")).toBe("Laptops");
  });

  it("collapses internal whitespace runs", () => {
    expect(normalizeCategoryName("Network   Switches")).toBe("Network Switches");
  });

  it("collapses tabs and newlines too", () => {
    expect(normalizeCategoryName("Network\t\nSwitches")).toBe("Network Switches");
  });

  it("preserves case for display", () => {
    // Uniqueness is enforced case-insensitively by the citext column; the
    // stored casing is what the admin typed.
    expect(normalizeCategoryName("LAPTOPS")).toBe("LAPTOPS");
  });

  it("returns an empty string for whitespace-only input", () => {
    // The caller treats "" as invalid — this must not become a category row.
    expect(normalizeCategoryName("   ")).toBe("");
    expect(normalizeCategoryName("")).toBe("");
  });

  it("leaves an already-canonical name untouched", () => {
    expect(normalizeCategoryName("Laptops")).toBe("Laptops");
  });
});
