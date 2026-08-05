import { describe, it, expect } from "vitest";
import nextConfig from "../next.config";

// Asserts the header MAPPING itself — nextConfig.headers() is a plain async
// function returning a data structure, so it can be called directly in a
// no-DB Node test without starting a dev or prod server. This is NOT proof
// the header reaches a real response: Next only applies `headers()` rules
// through its own request pipeline, which this test never runs. It pins the
// shape (which `source` patterns exist and what they carry) so a regression
// here — a dropped rule, a renamed key, a typo'd value — fails a fast test
// instead of only ever surfacing in the manual browser check noted in
// docs/SECURITY.md §3.
describe("next.config headers()", () => {
  it("sets Referrer-Policy: no-referrer on /receipts/*, protecting the receipt-link token", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    const rule = rules.find((r) => r.source === "/receipts/:path*");
    expect(rule).toBeDefined();
    expect(rule?.headers).toContainEqual({ key: "Referrer-Policy", value: "no-referrer" });
  });

  it("leaves the existing reset-password/forgot-password rule untouched", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    const rule = rules.find((r) => r.source === "/:path(reset-password|forgot-password)");
    expect(rule).toBeDefined();
    expect(rule?.headers).toContainEqual({ key: "Referrer-Policy", value: "no-referrer" });
  });

  it("does NOT cover /i/* — no token is ever put on an item URL", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    const sources = rules.map((r) => r.source);
    expect(sources.some((s) => s.includes("/i/"))).toBe(false);
  });
});
