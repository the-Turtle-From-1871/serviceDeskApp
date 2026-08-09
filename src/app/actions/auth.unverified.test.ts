import { beforeEach, describe, expect, it, vi } from "vitest";

// Conventions follow auth.rate-limit.test.ts.
const { AuthError } = vi.hoisted(() => ({ AuthError: class AuthError extends Error {} }));
vi.mock("next-auth", () => ({ AuthError }));

const signIn = vi.hoisted(() => vi.fn());
vi.mock("@/auth", () => ({ signIn: (...a: unknown[]) => signIn(...a), signOut: vi.fn() }));

const recordAuthFailure = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth-velocity", () => ({
  recordAuthFailure: (...a: unknown[]) => recordAuthFailure(...a),
  authVelocityElevated: vi.fn(async () => false),
}));

vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-forwarded-for": "198.51.100.9" }) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock("@/lib/prisma", () => ({ default: {} }));
vi.mock("@/lib/password-reset", () => ({ createPasswordResetToken: vi.fn(), resetPasswordWithToken: vi.fn() }));
vi.mock("@/modules/auth/send-password-reset-email", () => ({ sendPasswordResetEmail: vi.fn() }));
vi.mock("@/modules/users/users.service", () => ({ createSelfRegisteredUser: vi.fn() }));
vi.mock("@/lib/email-verification", () => ({ createEmailVerificationToken: vi.fn() }));
vi.mock("@/modules/auth/send-verification-email", () => ({ sendVerificationEmail: vi.fn() }));

const consumeRateLimit = vi.hoisted(() => vi.fn());
const resetRateLimit = vi.hoisted(() => vi.fn());
vi.mock("@/lib/rate-limit", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return {
    ...actual,
    consumeRateLimit: (...a: unknown[]) => consumeRateLimit(...a),
    resetRateLimit: (...a: unknown[]) => resetRateLimit(...a),
  };
});

const verifyTurnstile = vi.hoisted(() => vi.fn());
vi.mock("@/lib/turnstile", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, verifyTurnstile: (...a: unknown[]) => verifyTurnstile(...a) };
});

import { loginAction } from "./auth";
import { EMAIL_NOT_VERIFIED } from "@/modules/auth/credentials";

function form() {
  const fd = new FormData();
  fd.set("email", "jane@unit.mil");
  fd.set("password", "correct horse battery staple");
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  consumeRateLimit.mockResolvedValue({ allowed: true });
  verifyTurnstile.mockResolvedValue({ ok: true, status: "verified" });
});

describe("loginAction — unconfirmed email address", () => {
  // @auth/core can surface a thrown CredentialsSignin either way depending on
  // how the request was made, so both shapes must be handled identically.
  it("reports the unverified state when signIn THROWS the coded error", async () => {
    const err = Object.assign(new AuthError("x"), { code: EMAIL_NOT_VERIFIED });
    signIn.mockRejectedValue(err);
    const res = await loginAction(undefined, form());
    expect(res).toEqual({ unverified: true, email: "jane@unit.mil" });
  });

  it("reports the unverified state when signIn RETURNS an error URL carrying the code", async () => {
    signIn.mockResolvedValue(`/login?error=CredentialsSignin&code=${EMAIL_NOT_VERIFIED}`);
    const res = await loginAction(undefined, form());
    expect(res).toEqual({ unverified: true, email: "jane@unit.mil" });
  });

  // The bcrypt compare SUCCEEDED, so this is not a credential failure. Counting
  // it would let ordinary sign-up traffic drive the app-wide botnet escalation
  // that auth-velocity.ts exists to keep attacker-untriggerable.
  it("does NOT record an auth failure — the password was right", async () => {
    signIn.mockResolvedValue(`/login?error=CredentialsSignin&code=${EMAIL_NOT_VERIFIED}`);
    await loginAction(undefined, form());
    expect(recordAuthFailure).not.toHaveBeenCalled();
  });

  // Still a failed sign-in, so the budget is not handed back.
  it("does NOT refund the rate-limit token", async () => {
    signIn.mockResolvedValue(`/login?error=CredentialsSignin&code=${EMAIL_NOT_VERIFIED}`);
    await loginAction(undefined, form());
    expect(resetRateLimit).not.toHaveBeenCalled();
  });

  it("never leaks the specific message for an ordinary wrong password", async () => {
    signIn.mockResolvedValue("/login?error=CredentialsSignin");
    const res = await loginAction(undefined, form());
    expect(res).toEqual({ error: "Invalid email or password." });
    expect(recordAuthFailure).toHaveBeenCalledTimes(1);
  });
});
