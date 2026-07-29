import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// Same stubs as `auth.rate-limit.test.ts` — see the note there on why
// `next-auth` is replaced rather than imported.
const signIn = vi.fn();
const { AuthError } = vi.hoisted(() => ({ AuthError: class AuthError extends Error {} }));
vi.mock("next-auth", () => ({ AuthError }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/auth", () => ({ signIn: (...a: unknown[]) => signIn(...a), signOut: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ default: {} }));
vi.mock("@/lib/password-reset", () => ({
  createPasswordResetToken: vi.fn(),
  resetPasswordWithToken: vi.fn(),
}));
vi.mock("@/modules/auth/send-password-reset-email", () => ({ sendPasswordResetEmail: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "198.51.100.9" }),
}));

import { loginAction } from "./auth";
import {
  AUTH_SPRAY_POLICY,
  __memoryHitCountForTests,
  __resetRateLimitStateForTests,
} from "@/lib/rate-limit";
import {
  AUTH_VELOCITY_KEY,
  AUTH_VELOCITY_POLICY,
  __resetAuthVelocityStateForTests,
  authVelocityElevated,
  recordAuthFailure,
} from "@/lib/auth-velocity";
import { TURNSTILE_FIELD } from "@/lib/turnstile";

const SITE_KEY = "1x00000000000000000000AA";
const SECRET_KEY = "1x0000000000000000000000000000000AA";
const fetchMock = vi.fn();

const creds = (token?: string, email = "tech@example.com") => {
  const f = new FormData();
  f.set("email", email);
  f.set("password", "hunter2hunter2");
  if (token !== undefined) f.set(TURNSTILE_FIELD, token);
  return f;
};

const configureTurnstile = () => {
  vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", SITE_KEY);
  vi.stubEnv("TURNSTILE_SECRET_KEY", SECRET_KEY);
};
const siteverify = (body: Record<string, unknown>) =>
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => body });

const CHALLENGE_MESSAGE = /Could not verify that request came from a browser/;

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimitStateForTests();
  __resetAuthVelocityStateForTests();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  signIn.mockRejectedValue(new AuthError("CredentialsSignin"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __resetRateLimitStateForTests();
  __resetAuthVelocityStateForTests();
});

describe("loginAction — Turnstile", () => {
  it("does not challenge at all when no keys are configured", async () => {
    const res = await loginAction(undefined, creds());
    expect(res).toEqual({ error: "Invalid email or password." });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(signIn).toHaveBeenCalled();
  });

  it("refuses a submission with no token, WITHOUT reaching the password check", async () => {
    // The point of the widget: keep headless scripts away from bcrypt entirely.
    configureTurnstile();
    const res = await loginAction(undefined, creds());
    expect(res?.error).toMatch(CHALLENGE_MESSAGE);
    expect(signIn).not.toHaveBeenCalled();
  });

  it("proceeds when Cloudflare confirms the token", async () => {
    configureTurnstile();
    siteverify({ success: true });
    const res = await loginAction(undefined, creds("solved"));
    expect(res).toEqual({ error: "Invalid email or password." });
    expect(signIn).toHaveBeenCalled();
  });

  it("refuses a token Cloudflare rejects", async () => {
    configureTurnstile();
    siteverify({ success: false, "error-codes": ["invalid-input-response"] });
    const res = await loginAction(undefined, creds("forged"));
    expect(res?.error).toMatch(CHALLENGE_MESSAGE);
    expect(signIn).not.toHaveBeenCalled();
  });

  it("does NOT count a refused challenge as a failed login", async () => {
    // The global detector must measure guessing, not its own filters —
    // otherwise anyone could raise the alarm without trying a password.
    configureTurnstile();
    for (let i = 0; i < AUTH_SPRAY_POLICY.limit; i++) {
      await loginAction(undefined, creds(undefined, `v${i}@example.com`));
    }
    expect(__memoryHitCountForTests(AUTH_VELOCITY_KEY)).toBe(0);
  });
});

describe("loginAction — Turnstile under a detected attack", () => {
  // Driven through `recordAuthFailure` directly: the global bucket is what is
  // under test, and pushing 100 real logins through would trip the per-IP
  // limiter first and prove nothing about the velocity state.
  const elevate = async () => {
    for (let i = 0; i < AUTH_VELOCITY_POLICY.limit; i++) await recordAuthFailure();
    expect(await authVelocityElevated()).toBe(true);
  };

  it("lets an unverifiable submission through while things are normal", async () => {
    // A Cloudflare outage must not lock the service desk out of its own
    // property book. The password check and the rate limiter still apply.
    configureTurnstile();
    fetchMock.mockRejectedValue(new Error("ETIMEDOUT"));
    const res = await loginAction(undefined, creds("unverifiable"));
    expect(res).toEqual({ error: "Invalid email or password." });
    expect(signIn).toHaveBeenCalled();
  });

  it("REFUSES an unverifiable submission once the global failure rate is elevated", async () => {
    // The detector's teeth. During a distributed attack the availability trade
    // flips: an unverifiable sign-in is no longer worth the benefit of the
    // doubt. A real technician retries in a minute.
    configureTurnstile();
    await elevate();

    fetchMock.mockRejectedValue(new Error("ETIMEDOUT"));
    const res = await loginAction(undefined, creds("unverifiable"));
    expect(res?.error).toMatch(CHALLENGE_MESSAGE);
    expect(signIn).not.toHaveBeenCalled();
  });

  it("still accepts a VERIFIED token while elevated", async () => {
    // Strict mode must not lock out the people it is protecting.
    configureTurnstile();
    await elevate();

    siteverify({ success: true });
    const res = await loginAction(undefined, creds("solved"));
    expect(res).toEqual({ error: "Invalid email or password." });
    expect(signIn).toHaveBeenCalled();
  });
});

describe("loginAction — global velocity", () => {
  it("counts every genuinely failed credential check", async () => {
    // A distinct email each time, so the per-account bucket never binds and the
    // per-network ceiling is what bounds the run — every one of those attempts
    // reached a password, and each must produce exactly one global failure.
    for (let i = 0; i < AUTH_SPRAY_POLICY.limit; i++) {
      await loginAction(undefined, creds(undefined, `v${i}@example.com`));
    }
    expect(__memoryHitCountForTests(AUTH_VELOCITY_KEY)).toBe(AUTH_SPRAY_POLICY.limit);
  });

  it("does NOT count a throttled attempt", async () => {
    // Three times the ceiling, but only the first `limit` reach a password —
    // the rest are refused before `signIn`. Counting those would let one host
    // trip the app-wide alarm on its own, i.e. the detector would be measuring
    // its own limiter instead of the attack.
    for (let i = 0; i < AUTH_SPRAY_POLICY.limit * 3; i++) {
      await loginAction(undefined, creds(undefined, `v${i}@example.com`));
    }
    expect(__memoryHitCountForTests(AUTH_VELOCITY_KEY)).toBe(AUTH_SPRAY_POLICY.limit);
  });
});
