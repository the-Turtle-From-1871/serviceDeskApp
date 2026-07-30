import { describe, it, expect, vi, beforeEach } from "vitest";

const verifyPin = vi.fn();
const cookieSet = vi.fn();
const redirect = vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); });

vi.mock("@/lib/public-access", () => ({ verifyPin: (p: string) => verifyPin(p) }));
// `headers()` is here because the action now derives a rate-limit key from the
// client IP. A fixed IP keeps every test in this file in one bucket, which is
// what the throttling test below relies on.
const TEST_IP = "203.0.113.7";
vi.mock("next/headers", () => ({
  cookies: async () => ({ set: (...a: unknown[]) => cookieSet(...a) }),
  headers: async () => new Headers({ "x-forwarded-for": TEST_IP }),
}));
vi.mock("next/navigation", () => ({ redirect: (u: string) => redirect(u) }));

import { unlockAction } from "./unlock";
import { UNLOCK_MAX_AGE_SECONDS } from "@/lib/public-access-cookie";
import { UNLOCK_POLICY, __resetRateLimitStateForTests } from "@/lib/rate-limit";

function fd(entries: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_SECRET = "test-secret";
  // Wrong-PIN tests spend rate-limit tokens; without this the buckets carry
  // between tests and a later case fails as "throttled" for reasons unrelated
  // to what it asserts.
  __resetRateLimitStateForTests();
});

describe("unlockAction", () => {
  it("rejects a non-8-digit PIN without hitting verifyPin", async () => {
    const res = await unlockAction(undefined, fd({ pin: "12ab", next: "/i/x" }));
    expect(res).toEqual({ error: "Enter the 8-digit PIN." });
    expect(verifyPin).not.toHaveBeenCalled();
  });

  it("returns a generic error on an incorrect PIN", async () => {
    verifyPin.mockResolvedValue(false);
    const res = await unlockAction(undefined, fd({ pin: "00000000", next: "/i/x" }));
    expect(res).toEqual({ error: "Incorrect PIN." });
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it("sets the unlock cookie and redirects to the sanitized next on success", async () => {
    verifyPin.mockResolvedValue(true);
    await expect(unlockAction(undefined, fd({ pin: "12345678", next: "/i/abc" })))
      .rejects.toThrow("REDIRECT:/i/abc");
    expect(cookieSet).toHaveBeenCalledTimes(1);
    const [name, value, opts] = cookieSet.mock.calls[0];
    expect(name).toBe("pub_unlock"); // NODE_ENV is "test" -> not secure
    // Kept: `String(value)` below would coerce a non-string away, so the type
    // needs pinning separately.
    expect(typeof value).toBe("string");
    expect(opts).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: UNLOCK_MAX_AGE_SECONDS,
    });

    // Decode the SIGNED expiry rather than only checking the cookie's maxAge
    // against the same constant the action writes — that comparison is true by
    // construction and cannot fail, so setting UNLOCK_MAX_AGE_SECONDS to 60
    // would keep the suite green while every unlock lasted a minute. This pins
    // the actual duration AND that the browser-side lifetime matches the signed
    // one, which is the invariant the old comment claimed but never asserted.
    const signedExpMs = Number(String(value).split(".")[0]);
    expect(Number.isFinite(signedExpMs)).toBe(true);
    expect(signedExpMs - Date.now()).toBeGreaterThan(UNLOCK_MAX_AGE_SECONDS * 1000 - 5_000);
    expect(signedExpMs - Date.now()).toBeLessThanOrEqual(UNLOCK_MAX_AGE_SECONDS * 1000);
    // 12 hours, spelled out: a literal here is the independent oracle. Without
    // it both sides of every other assertion move together when the constant does.
    expect(UNLOCK_MAX_AGE_SECONDS).toBe(12 * 60 * 60);
  });

  it("redirects to / when next is an open-redirect attempt", async () => {
    verifyPin.mockResolvedValue(true);
    await expect(unlockAction(undefined, fd({ pin: "12345678", next: "https://evil.com" })))
      .rejects.toThrow("REDIRECT:/");
  });

  it("returns a generic error (does not throw) when verifyPin rejects", async () => {
    verifyPin.mockRejectedValue(new Error("DB connection lost"));
    const res = await unlockAction(undefined, fd({ pin: "12345678", next: "/i/x" }));
    expect(res).toEqual({ error: "Something went wrong. Please try again." });
    expect(cookieSet).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  describe("rate limiting", () => {
    it("stops guessing after the auth budget is spent, without calling verifyPin again", async () => {
      verifyPin.mockResolvedValue(false);
      for (let i = 0; i < UNLOCK_POLICY.limit; i++) {
        expect(await unlockAction(undefined, fd({ pin: "00000000", next: "/i/x" })))
          .toEqual({ error: "Incorrect PIN." });
      }
      const spentCalls = verifyPin.mock.calls.length;

      const res = await unlockAction(undefined, fd({ pin: "00000000", next: "/i/x" }));
      expect(res.error).toMatch(/Too many attempts/);
      // The refusal happens BEFORE the bcrypt compare — otherwise the limiter
      // would still be paying the cost it exists to avoid.
      expect(verifyPin.mock.calls.length).toBe(spentCalls);
      // 20 wrong PINs x the deliberate 400ms anti-guessing delay is ~8s.
    }, 30_000);

    it("CHARGES a correct PIN too, because the bucket is shared", async () => {
      // Deliberate reversal. Refunding on success looked kind — five people
      // unlocking would otherwise spend the budget — but this bucket is keyed
      // `(scope, ip)` and therefore SHARED by everyone on that network, and
      // `resetRateLimit` empties a bucket rather than decrementing it. So the
      // refund handed an attacker sitting on the same egress a fresh five
      // guesses at an 8-digit secret every time a colleague unlocked
      // legitimately; on a busy morning the cap was effectively unbounded.
      verifyPin.mockResolvedValue(true);
      for (let i = 0; i < UNLOCK_POLICY.limit; i++) {
        await expect(unlockAction(undefined, fd({ pin: "12345678", next: "/i/x" })))
          .rejects.toThrow("REDIRECT:/i/x");
      }
      const res = await unlockAction(undefined, fd({ pin: "12345678", next: "/i/x" }));
      expect(res.error).toMatch(/Too many attempts/);
    });

    it("does not let a colleague's correct PIN refill an attacker's guesses", async () => {
      // The property the refund destroyed, stated directly.
      verifyPin.mockResolvedValue(false);
      for (let i = 0; i < UNLOCK_POLICY.limit - 1; i++) {
        await unlockAction(undefined, fd({ pin: "00000000", next: "/i/x" }));
      }
      verifyPin.mockResolvedValue(true);
      await expect(unlockAction(undefined, fd({ pin: "12345678", next: "/i/x" })))
        .rejects.toThrow("REDIRECT:/i/x");

      verifyPin.mockResolvedValue(false);
      const res = await unlockAction(undefined, fd({ pin: "00000001", next: "/i/x" }));
      expect(res.error).toMatch(/Too many attempts/);
    }, 30_000);

    it("does not charge a malformed submission against the budget", async () => {
      // A typo that never reached the PIN check is not a guess.
      for (let i = 0; i < UNLOCK_POLICY.limit * 2; i++) {
        expect(await unlockAction(undefined, fd({ pin: "12ab", next: "/i/x" })))
          .toEqual({ error: "Enter the 8-digit PIN." });
      }
      verifyPin.mockResolvedValue(true);
      await expect(unlockAction(undefined, fd({ pin: "12345678", next: "/i/x" })))
        .rejects.toThrow("REDIRECT:/i/x");
    });
  });
});
