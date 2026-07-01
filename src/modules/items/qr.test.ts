import { expect, test } from "vitest";
import { itemUrl, itemQrDataUrl } from "./qr";

test("itemUrl builds the absolute item link", () => {
  expect(itemUrl("abc", "https://hr.example")).toBe("https://hr.example/i/abc");
});

test("itemQrDataUrl returns a png data url", async () => {
  const url = await itemQrDataUrl("abc", "https://hr.example");
  expect(url.startsWith("data:image/png;base64,")).toBe(true);
});
