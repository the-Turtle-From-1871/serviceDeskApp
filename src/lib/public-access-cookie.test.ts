import { describe, it, expect } from "vitest";
import {
  signUnlockValue,
  verifyUnlockValue,
  sanitizeNext,
  shouldAllowPublic,
  unlockCookieName,
  UNLOCK_TTL_MS,
} from "./public-access-cookie";

const SECRET = "test-secret-abc";

describe("unlock cookie sign/verify", () => {
  it("round-trips a valid, unexpired value", async () => {
    const now = 1_000_000;
    const value = await signUnlockValue(now + UNLOCK_TTL_MS, SECRET);
    expect(await verifyUnlockValue(value, SECRET, now)).toBe(true);
  });

  it("rejects an expired value", async () => {
    const now = 1_000_000;
    const value = await signUnlockValue(now - 1, SECRET);
    expect(await verifyUnlockValue(value, SECRET, now)).toBe(false);
  });

  it("rejects a tampered signature", async () => {
    const now = 1_000_000;
    const value = await signUnlockValue(now + UNLOCK_TTL_MS, SECRET);
    const tampered = value.slice(0, -2) + (value.endsWith("aa") ? "bb" : "aa");
    expect(await verifyUnlockValue(tampered, SECRET, now)).toBe(false);
  });

  it("rejects a value signed with a different secret", async () => {
    const now = 1_000_000;
    const value = await signUnlockValue(now + UNLOCK_TTL_MS, SECRET);
    expect(await verifyUnlockValue(value, "other-secret", now)).toBe(false);
  });

  it("rejects undefined/garbage", async () => {
    expect(await verifyUnlockValue(undefined, SECRET, 0)).toBe(false);
    expect(await verifyUnlockValue("nodot", SECRET, 0)).toBe(false);
    expect(await verifyUnlockValue(".sig", SECRET, 0)).toBe(false);
  });
});

describe("sanitizeNext", () => {
  it("keeps a same-origin relative path", () => {
    expect(sanitizeNext("/i/abc123")).toBe("/i/abc123");
    expect(sanitizeNext("/receipts/HR-000001?x=1")).toBe("/receipts/HR-000001?x=1");
  });
  it("rejects protocol-relative and absolute URLs", () => {
    expect(sanitizeNext("//evil.com")).toBe("/");
    expect(sanitizeNext("https://evil.com")).toBe("/");
    expect(sanitizeNext("/\\evil.com")).toBe("/");
  });
  it("rejects non-strings and the unlock page itself", () => {
    expect(sanitizeNext(null)).toBe("/");
    expect(sanitizeNext(undefined)).toBe("/");
    expect(sanitizeNext("relative")).toBe("/");
    expect(sanitizeNext("/unlock")).toBe("/");
    expect(sanitizeNext("/unlock?next=/x")).toBe("/");
  });
  it("rejects control chars and backslashes (open-redirect normalization)", () => {
    expect(sanitizeNext("/\t/evil.com")).toBe("/");
    expect(sanitizeNext("/\n/evil.com")).toBe("/");
    expect(sanitizeNext("/foo\\bar")).toBe("/");
    expect(sanitizeNext("/%09/evil")).toBe("/%09/evil"); // literal %09 (already-encoded) is a normal path, still allowed
  });
});

describe("shouldAllowPublic", () => {
  it("allows everything when the flag is off", () => {
    expect(shouldAllowPublic({ flagEnabled: false, loggedIn: false, unlockValid: false })).toBe(true);
  });
  it("with flag on, allows logged-in or unlocked, blocks otherwise", () => {
    expect(shouldAllowPublic({ flagEnabled: true, loggedIn: true, unlockValid: false })).toBe(true);
    expect(shouldAllowPublic({ flagEnabled: true, loggedIn: false, unlockValid: true })).toBe(true);
    expect(shouldAllowPublic({ flagEnabled: true, loggedIn: false, unlockValid: false })).toBe(false);
  });
});

describe("unlockCookieName", () => {
  it("uses the __Secure- prefix only when secure", () => {
    expect(unlockCookieName(true)).toBe("__Secure-pub_unlock");
    expect(unlockCookieName(false)).toBe("pub_unlock");
  });
});
