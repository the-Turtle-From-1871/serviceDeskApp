import { describe, it, expect, vi } from "vitest";
import {
  signUnlockValue,
  verifyUnlockValue,
  sanitizeNext,
  shouldAllowPublic,
  unlockCookieName,
  UNLOCK_TTL_MS,
  UNLOCK_CLOCK_SKEW_MS,
} from "./public-access-cookie";

const SECRET = "test-secret-abc";

describe("unlock cookie sign/verify", () => {
  it("round-trips a valid, unexpired value", async () => {
    const now = 1_000_000;
    const value = await signUnlockValue(now + UNLOCK_TTL_MS, SECRET);
    expect((await verifyUnlockValue(value, SECRET, now)).valid).toBe(true);
  });

  it("rejects an expired value", async () => {
    const now = 1_000_000;
    const value = await signUnlockValue(now - 1, SECRET);
    expect((await verifyUnlockValue(value, SECRET, now)).valid).toBe(false);
  });

  it("rejects a validly-signed value that outlives the current TTL", async () => {
    // A cookie minted under a longer window: signature is genuine, expiry is
    // still in the future, but it claims far more life than the TTL allows.
    //
    // Expressed RELATIVE to the constant. Hard-coding the previous 7-day window
    // would make this test fail on correct code the moment anyone raises the
    // TTL — a red suite in a security file for a case the boundary test below
    // already covers exactly.
    const now = 1_000_000;
    const value = await signUnlockValue(now + UNLOCK_TTL_MS * 2, SECRET);
    expect((await verifyUnlockValue(value, SECRET, now)).valid).toBe(false);
  });

  it("tolerates clock skew between the signing and verifying instance", async () => {
    // Signed on an instance running ahead of the verifier: still legitimate.
    const now = 1_000_000;
    const value = await signUnlockValue(now + UNLOCK_TTL_MS + UNLOCK_CLOCK_SKEW_MS - 1, SECRET);
    expect((await verifyUnlockValue(value, SECRET, now)).valid).toBe(true);
  });

  it("rejects a value beyond the TTL plus the skew allowance", async () => {
    const now = 1_000_000;
    const value = await signUnlockValue(now + UNLOCK_TTL_MS + UNLOCK_CLOCK_SKEW_MS + 1, SECRET);
    expect((await verifyUnlockValue(value, SECRET, now)).valid).toBe(false);
  });

  it("refuses CLEANLY with no secret, rather than throwing out of the caller", async () => {
    // NOT a bypass fix. Web Crypto rejects a zero-length HMAC key, so a blank
    // AUTH_SECRET always threw a DOMException from importKey — the gate was
    // closed, but by 500-ing every public page. What is asserted here is the
    // difference this change actually makes: a returned refusal, not a crash.
    // `rejects.toThrow` would pass against the old code too, which is why the
    // assertion is on the resolved value.
    const now = 1_000_000;
    const genuine = await signUnlockValue(now + UNLOCK_TTL_MS, SECRET);
    const result = await verifyUnlockValue(genuine, "", now);
    expect(result).toEqual({ valid: false, retire: false });

    // Not retired either: a missing key is a config fault, not evidence the
    // cookie is spent, so the proxy must not delete everyone's cookie over it.
    expect(result.retire).toBe(false);

    // Signing still throws, but with a message naming the variable instead of
    // an opaque DOMException from inside importKey.
    await expect(signUnlockValue(now + UNLOCK_TTL_MS, "")).rejects.toThrow(/AUTH_SECRET/);
  });

  it("marks a cookie for retirement ONLY when its signature is genuinely ours", async () => {
    const now = 1_000_000;

    // Ours, but past the ceiling -> retire it from the browser.
    const stale = await signUnlockValue(now + UNLOCK_TTL_MS * 2, SECRET);
    expect(await verifyUnlockValue(stale, SECRET, now)).toEqual({ valid: false, retire: true });

    // Ours, but expired -> also retire.
    const expired = await signUnlockValue(now - 1, SECRET);
    expect(await verifyUnlockValue(expired, SECRET, now)).toEqual({ valid: false, retire: true });

    // NOT ours. A stranger can put any string in a cookie; acting on it would
    // let them trigger the browser-side delete and the ceiling warning at will.
    const forged = `${now + UNLOCK_TTL_MS * 2}.${"x".repeat(43)}`;
    expect(await verifyUnlockValue(forged, SECRET, now)).toEqual({ valid: false, retire: false });
  });

  it("does not log a ceiling warning for a value it never signed", async () => {
    // The warning is the only signal separating a real clock-skew lockout from
    // a wrong PIN, so it must not be spoofable by an unauthenticated visitor —
    // and the check must not burn CPU or log lines on junk.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const now = 1_000_000;
    await verifyUnlockValue(`${now + UNLOCK_TTL_MS * 99}.${"x".repeat(43)}`, SECRET, now);
    expect(warn).not.toHaveBeenCalled();

    // A genuine over-ceiling cookie DOES warn.
    await verifyUnlockValue(await signUnlockValue(now + UNLOCK_TTL_MS * 2, SECRET), SECRET, now);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("rejects a tampered signature", async () => {
    const now = 1_000_000;
    const value = await signUnlockValue(now + UNLOCK_TTL_MS, SECRET);
    const tampered = value.slice(0, -2) + (value.endsWith("aa") ? "bb" : "aa");
    expect((await verifyUnlockValue(tampered, SECRET, now)).valid).toBe(false);
  });

  it("rejects a value signed with a different secret", async () => {
    const now = 1_000_000;
    const value = await signUnlockValue(now + UNLOCK_TTL_MS, SECRET);
    expect((await verifyUnlockValue(value, "other-secret", now)).valid).toBe(false);
  });

  it("rejects undefined/garbage", async () => {
    expect((await verifyUnlockValue(undefined, SECRET, 0)).valid).toBe(false);
    expect((await verifyUnlockValue("nodot", SECRET, 0)).valid).toBe(false);
    expect((await verifyUnlockValue(".sig", SECRET, 0)).valid).toBe(false);
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
