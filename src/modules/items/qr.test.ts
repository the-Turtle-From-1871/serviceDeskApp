import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { itemUrl, receiptLinkUrl, receiptUrl } from "./qr";
import { verifyReceiptLinkToken } from "@/lib/receipt-link-token";

it("builds an absolute receipt URL", () => {
  expect(receiptUrl("HR-AAAA1111", "https://app.example")).toBe("https://app.example/receipts/HR-AAAA1111");
});

it("builds an absolute item URL", () => {
  expect(itemUrl("itm1", "https://app.example")).toBe("https://app.example/i/itm1");
});

describe("receiptLinkUrl", () => {
  beforeEach(() => {
    vi.stubEnv("AUTH_SECRET", "test-secret");
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("appends a token the proxy will accept for that receipt", async () => {
    const url = await receiptLinkUrl("HR-000123", "https://app.example");
    const token = new URL(url).searchParams.get("k") ?? "";
    expect(url.startsWith("https://app.example/receipts/HR-000123?k=")).toBe(true);
    expect(await verifyReceiptLinkToken("HR-000123", token, "test-secret")).toBe(true);
  });

  it("mints a token that does NOT open a different receipt", async () => {
    const url = await receiptLinkUrl("HR-000123", "https://app.example");
    const token = new URL(url).searchParams.get("k") ?? "";
    expect(await verifyReceiptLinkToken("HR-000456", token, "test-secret")).toBe(false);
  });

  it("falls back to the plain URL when signing throws", async () => {
    // A misconfigured deploy must not fail a receipt email or a PDF render — the
    // recipient gets the PIN prompt, which is exactly today's behavior.
    vi.stubEnv("AUTH_SECRET", "");
    expect(await receiptLinkUrl("HR-000123", "https://app.example")).toBe(
      "https://app.example/receipts/HR-000123",
    );
  });
});
