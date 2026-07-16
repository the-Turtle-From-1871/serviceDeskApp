import { describe, it, expect } from "vitest";
import { parseItemScan } from "./scan-url";

const ID = "clx3k9v2p0001abcd1234efgh";

describe("parseItemScan", () => {
  it("reads the id from a production sticker", () => {
    expect(parseItemScan(`https://servicedeskapp.vercel.app/i/${ID}`)).toBe(ID);
  });

  // The origin baked into a sticker is whatever defaultBaseUrl() resolved to at
  // PRINT time (lib/base-url.ts:5-9). These three cases are why we match on the
  // PATH: origin-strict matching would reject stickers that are physically on
  // hardware right now.
  it("reads the id from a sticker printed on a preview deploy", () => {
    expect(parseItemScan(`https://app-git-feat-x.vercel.app/i/${ID}`)).toBe(ID);
  });

  it("reads the id from a sticker printed before a domain change", () => {
    expect(parseItemScan(`https://old-domain.example/i/${ID}`)).toBe(ID);
  });

  it("reads the id from a bare path (printed from local dev, no APP_URL)", () => {
    // defaultBaseUrl() returns "" with neither APP_URL nor a Vercel env, so
    // itemUrl() emits `/i/{cuid}` with no scheme or host at all.
    expect(parseItemScan(`/i/${ID}`)).toBe(ID);
  });

  it("tolerates a trailing slash and a query string", () => {
    expect(parseItemScan(`https://x.example/i/${ID}/`)).toBe(ID);
    expect(parseItemScan(`https://x.example/i/${ID}?utm=1`)).toBe(ID);
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseItemScan(`  https://x.example/i/${ID}  `)).toBe(ID);
  });

  it("rejects a Wi-Fi QR", () => {
    // Parses as a URL with protocol "wifi:" — so the reject must come from the
    // PATH shape, not from URL parsing failing.
    expect(parseItemScan("WIFI:S:GuestNet;T:WPA;P:hunter2;;")).toBeNull();
  });

  it("rejects a receipt URL", () => {
    expect(parseItemScan("https://x.example/receipts/HR-2026-0001")).toBeNull();
  });

  it("rejects a nested path that merely contains /i/", () => {
    expect(parseItemScan(`https://x.example/admin/i/${ID}`)).toBeNull();
  });

  it("rejects a bare serial number, plain text, and empty input", () => {
    expect(parseItemScan("7X4K2L9")).toBeNull();
    expect(parseItemScan("hello world")).toBeNull();
    expect(parseItemScan("")).toBeNull();
    expect(parseItemScan("   ")).toBeNull();
  });
});
