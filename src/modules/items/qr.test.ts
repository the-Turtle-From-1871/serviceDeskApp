import { expect, it } from "vitest";
import { itemUrl, receiptUrl } from "./qr";

it("builds an absolute receipt URL", () => {
  expect(receiptUrl("HR-AAAA1111", "https://app.example")).toBe("https://app.example/receipts/HR-AAAA1111");
});

it("builds an absolute item URL", () => {
  expect(itemUrl("itm1", "https://app.example")).toBe("https://app.example/i/itm1");
});
