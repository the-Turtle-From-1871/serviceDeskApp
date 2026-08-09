import { beforeEach, describe, expect, it, vi } from "vitest";

// Conventions follow auth.rate-limit.test.ts: vi.hoisted stubs, next-auth stood
// in for (it cannot load under vitest), and `after()` CAPTURED rather than run
// so the tests can assert what happens before the response versus after it.
const { AuthError } = vi.hoisted(() => ({ AuthError: class AuthError extends Error {} }));
vi.mock("next-auth", () => ({ AuthError }));

const deferred = vi.hoisted(() => [] as (() => Promise<void> | void)[]);
vi.mock("next/server", () => ({ after: (fn: () => Promise<void> | void) => deferred.push(fn) }));

const TEST_IP = "198.51.100.7";
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": TEST_IP }),
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

const findUnique = vi.hoisted(() => vi.fn());
vi.mock("@/lib/prisma", () => ({ default: { user: { findUnique: (a: unknown) => findUnique(a) } } }));

vi.mock("@/auth", () => ({ signIn: vi.fn(), signOut: vi.fn() }));
vi.mock("@/lib/password-reset", () => ({
  createPasswordResetToken: vi.fn(),
  resetPasswordWithToken: vi.fn(),
}));
vi.mock("@/modules/auth/send-password-reset-email", () => ({ sendPasswordResetEmail: vi.fn() }));

const createSelfRegisteredUser = vi.hoisted(() => vi.fn());
vi.mock("@/modules/users/users.service", () => ({
  createSelfRegisteredUser: (i: unknown) => createSelfRegisteredUser(i),
}));

const createEmailVerificationToken = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email-verification", () => ({
  createEmailVerificationToken: (id: string) => createEmailVerificationToken(id),
}));

const sendVerificationEmail = vi.hoisted(() => vi.fn());
vi.mock("@/modules/auth/send-verification-email", () => ({
  sendVerificationEmail: (a: unknown) => sendVerificationEmail(a),
}));

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
// `turnstileConfigured` is overridden rather than driven through env vars: the
// no-token guard short-circuits when the challenge is not configured, and the
// test environment has no keys, so without this the "refuses a tokenless
// submission" case would silently pass through and assert nothing.
const turnstileConfigured = vi.hoisted(() => vi.fn(() => true));
vi.mock("@/lib/turnstile", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return {
    ...actual,
    turnstileConfigured: () => turnstileConfigured(),
    verifyTurnstile: (...a: unknown[]) => verifyTurnstile(...a),
  };
});

import { registerAction } from "./auth";
import { TURNSTILE_FIELD } from "@/lib/turnstile";

function form(over: Record<string, string> = {}) {
  const fd = new FormData();
  fd.set("name", "Jane Doe");
  fd.set("email", "jane@unit.mil");
  fd.set("password", "correct horse battery staple");
  fd.set(TURNSTILE_FIELD, "tok");
  for (const [k, v] of Object.entries(over)) fd.set(k, v);
  return fd;
}

async function runDeferred() {
  while (deferred.length) await deferred.shift()!();
}

beforeEach(() => {
  vi.clearAllMocks();
  deferred.length = 0;
  process.env.APP_URL = "https://www.dcsim.us";
  turnstileConfigured.mockReturnValue(true);
  consumeRateLimit.mockResolvedValue({ allowed: true });
  verifyTurnstile.mockResolvedValue({ ok: true, status: "verified" });
  findUnique.mockResolvedValue(null);
  createSelfRegisteredUser.mockResolvedValue({ id: "u1", email: "jane@unit.mil", name: "Jane Doe" });
  createEmailVerificationToken.mockResolvedValue("rawtoken");
  sendVerificationEmail.mockResolvedValue(undefined);
});

describe("registerAction — anti-enumeration", () => {
  it("returns the SAME generic success whether or not the address already exists", async () => {
    const fresh = await registerAction(undefined, form());
    findUnique.mockResolvedValue({ id: "existing", isActive: true });
    const taken = await registerAction(undefined, form());
    expect(fresh).toEqual({ ok: true });
    expect(taken).toEqual(fresh);
  });

  it("never creates a second account for an address that already exists", async () => {
    findUnique.mockResolvedValue({ id: "existing", isActive: true });
    await registerAction(undefined, form());
    await runDeferred();
    expect(createSelfRegisteredUser).not.toHaveBeenCalled();
    expect(sendVerificationEmail).not.toHaveBeenCalled();
  });

  it("does the account work AFTER responding, so response time reveals nothing", async () => {
    await registerAction(undefined, form());
    // Still nothing done — the whole point of the deferral.
    expect(findUnique).not.toHaveBeenCalled();
    expect(createSelfRegisteredUser).not.toHaveBeenCalled();
    await runDeferred();
    expect(createSelfRegisteredUser).toHaveBeenCalledTimes(1);
  });
});

describe("registerAction — happy path", () => {
  it("creates the account and emails a link built from APP_URL", async () => {
    await registerAction(undefined, form());
    await runDeferred();
    expect(createSelfRegisteredUser).toHaveBeenCalledTimes(1);
    const mail = sendVerificationEmail.mock.calls[0][0];
    expect(mail.to).toBe("jane@unit.mil");
    // A vercel.app origin here is what broke .mil delivery before.
    expect(mail.verifyUrl).toBe("https://www.dcsim.us/verify-email?token=rawtoken");
  });

  it("skips the send when no base URL is configured, rather than mailing a broken link", async () => {
    delete process.env.APP_URL;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    delete process.env.VERCEL_URL;
    await registerAction(undefined, form());
    await runDeferred();
    expect(sendVerificationEmail).not.toHaveBeenCalled();
  });

  it("swallows a deferred failure — the caller already got its response", async () => {
    sendVerificationEmail.mockRejectedValue(new Error("smtp down"));
    await registerAction(undefined, form());
    await expect(runDeferred()).resolves.toBeUndefined();
  });
});

describe("registerAction — abuse controls", () => {
  it("rejects a malformed email BEFORE spending a rate-limit token", async () => {
    const res = await registerAction(undefined, form({ email: "not-an-email" }));
    expect(res).toMatchObject({ error: expect.any(String) });
    expect(consumeRateLimit).not.toHaveBeenCalled();
  });

  it("rejects a short password before spending anything", async () => {
    const res = await registerAction(undefined, form({ password: "short" }));
    expect(res).toMatchObject({ error: expect.any(String) });
    expect(consumeRateLimit).not.toHaveBeenCalled();
  });

  it("refuses a submission carrying no Turnstile token, without charging it", async () => {
    const fd = form();
    fd.delete(TURNSTILE_FIELD);
    const res = await registerAction(undefined, fd);
    expect(res).toMatchObject({ error: expect.any(String) });
    expect(consumeRateLimit).not.toHaveBeenCalled();
    expect(deferred.length).toBe(0);
  });

  it("refuses when the challenge does not verify", async () => {
    verifyTurnstile.mockResolvedValue({ ok: false, status: "failed" });
    const res = await registerAction(undefined, form());
    expect(res).toMatchObject({ error: expect.any(String) });
    expect(deferred.length).toBe(0);
  });

  it("returns the throttle response and schedules nothing when the bucket is empty", async () => {
    consumeRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 60 });
    const res = await registerAction(undefined, form());
    expect(res).toMatchObject({ error: expect.any(String) });
    expect(deferred.length).toBe(0);
  });

  // Volume IS the abuse here, so a success must NOT hand the token back the way
  // loginAction does.
  it("never refunds a rate-limit token on success", async () => {
    await registerAction(undefined, form());
    await runDeferred();
    expect(resetRateLimit).not.toHaveBeenCalled();
  });

  it("spends its own scope, never login's", async () => {
    await registerAction(undefined, form());
    const keys = consumeRateLimit.mock.calls.map((c) => String(c[1]));
    expect(keys.some((k) => k.includes("register"))).toBe(true);
    expect(keys.some((k) => k.includes("login"))).toBe(false);
  });
});
