import { describe, it, expect } from "vitest";
import { generateReceiptNumber } from "./receipt-number";

describe("generateReceiptNumber", () => {
  it("matches HR- followed by 8 uppercase hex chars", () => {
    expect(generateReceiptNumber()).toMatch(/^HR-[0-9A-F]{8}$/);
  });
  it("is different across calls", () => {
    expect(generateReceiptNumber()).not.toBe(generateReceiptNumber());
  });
});
