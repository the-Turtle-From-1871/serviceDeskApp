import { expect, test, it } from "vitest";
import { itemUrl, itemQrDataUrl, receiptUrl } from "./qr";

test("itemUrl builds the absolute item link", () => {
  expect(itemUrl("abc", "https://hr.example")).toBe("https://hr.example/i/abc");
});

test("itemQrDataUrl returns a png data url", async () => {
  const url = await itemQrDataUrl("abc", "https://hr.example");
  expect(url.startsWith("data:image/png;base64,")).toBe(true);
});

it("builds an absolute receipt URL", () => {
  expect(receiptUrl("HR-AAAA1111", "https://app.example")).toBe("https://app.example/receipts/HR-AAAA1111");
});
