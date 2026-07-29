import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Upstash path cannot be exercised against a real store in CI, and the two
// things worth asserting about it are structural, not network-dependent:
// (1) it is actually SELECTED when credentials exist — otherwise a deploy could
// silently run the per-instance fallback forever, and (2) it fails OPEN, which
// is a deliberate availability choice that must not regress into a lockout.
const mocks = vi.hoisted(() => ({
  limit: vi.fn(),
  resetUsedTokens: vi.fn(),
  getRemaining: vi.fn(),
  slidingWindow: vi.fn(() => "sliding-window-config"),
  redisCtor: vi.fn(),
}));

vi.mock("@upstash/redis", () => ({
  Redis: class {
    constructor(opts: unknown) {
      mocks.redisCtor(opts);
    }
  },
}));

vi.mock("@upstash/ratelimit", () => {
  class Ratelimit {
    limit = mocks.limit;
    resetUsedTokens = mocks.resetUsedTokens;
    getRemaining = mocks.getRemaining;
    static slidingWindow = mocks.slidingWindow;
  }
  return { Ratelimit };
});

import {
  AUTH_POLICY,
  __resetRateLimitStateForTests,
  consumeRateLimit,
  readRateLimit,
  resetRateLimit,
} from "./rate-limit";

beforeEach(() => {
  __resetRateLimitStateForTests();
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubEnv("KV_REST_API_URL", "https://example.upstash.io");
  vi.stubEnv("KV_REST_API_TOKEN", "token");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  __resetRateLimitStateForTests();
});

describe("Upstash backend selection", () => {
  it("uses the configured store rather than the in-memory fallback", async () => {
    mocks.limit.mockResolvedValue({
      success: true,
      limit: 5,
      remaining: 4,
      reset: Date.now() + 60_000,
      pending: Promise.resolve(),
    });
    const v = await consumeRateLimit(AUTH_POLICY, "auth:login:1.2.3.4");
    expect(mocks.limit).toHaveBeenCalledWith("auth:login:1.2.3.4");
    expect(mocks.redisCtor).toHaveBeenCalledWith({
      url: "https://example.upstash.io",
      token: "token",
    });
    expect(v.allowed).toBe(true);
    expect(v.remaining).toBe(4);
  });

  it("builds the limiter from the policy, so 5/15min is what reaches Redis", async () => {
    mocks.limit.mockResolvedValue({
      success: true,
      limit: 5,
      remaining: 4,
      reset: Date.now(),
      pending: Promise.resolve(),
    });
    await consumeRateLimit(AUTH_POLICY, "k");
    expect(mocks.slidingWindow).toHaveBeenCalledWith(5, "900 s");
  });

  it("reuses one client across calls instead of reconnecting per request", async () => {
    mocks.limit.mockResolvedValue({
      success: true,
      limit: 5,
      remaining: 4,
      reset: Date.now(),
      pending: Promise.resolve(),
    });
    await consumeRateLimit(AUTH_POLICY, "k");
    await consumeRateLimit(AUTH_POLICY, "k");
    expect(mocks.redisCtor).toHaveBeenCalledTimes(1);
  });

  it("takes `success` from the store, not from a re-derived `remaining`", async () => {
    mocks.limit.mockResolvedValue({
      success: false,
      limit: 5,
      remaining: 0,
      reset: Date.now() + 120_000,
      pending: Promise.resolve(),
    });
    const v = await consumeRateLimit(AUTH_POLICY, "k");
    expect(v.allowed).toBe(false);
    expect(v.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("reads a bucket without spending from it", async () => {
    // `readRateLimit` is what the botnet detector asks "are we under attack?",
    // and it must not itself count as an attempt — otherwise merely checking
    // often enough would raise the alarm. This path had no coverage on the
    // production backend at all.
    mocks.getRemaining.mockResolvedValue({ remaining: 0, reset: Date.now() + 1_000, limit: 100 });
    const v = await readRateLimit(AUTH_POLICY, "auth-velocity:global");
    expect(mocks.getRemaining).toHaveBeenCalledWith("auth-velocity:global");
    expect(mocks.limit).not.toHaveBeenCalled();
    expect(v.allowed).toBe(false);
  });

  it("reports a bucket with room left as allowed", async () => {
    mocks.getRemaining.mockResolvedValue({ remaining: 7, reset: Date.now() + 1_000, limit: 100 });
    expect((await readRateLimit(AUTH_POLICY, "k")).allowed).toBe(true);
  });

  it("refunds through the store, not just the local map", async () => {
    // The refund is what keeps a successful sign-in free. If it only cleared an
    // in-process map, an office behind one NAT IP would still lock itself out
    // the moment Redis was attached — the exact configuration this is for.
    mocks.resetUsedTokens.mockResolvedValue(undefined);
    await resetRateLimit(AUTH_POLICY, "auth:login:1.2.3.4");
    expect(mocks.resetUsedTokens).toHaveBeenCalledWith("auth:login:1.2.3.4");
  });
});

describe("Upstash outage", () => {
  it("fails OPEN on consume rather than locking the desk out", async () => {
    mocks.limit.mockRejectedValue(new Error("ECONNRESET"));
    const v = await consumeRateLimit(AUTH_POLICY, "k");
    expect(v.allowed).toBe(true);
    expect(console.error).toHaveBeenCalled();
  });

  it("reports NOT elevated when a read fails, rather than inventing an attack", async () => {
    // Fails open in the direction that does not put the app into a stricter
    // mode nobody asked for, on top of whatever outage caused it.
    mocks.getRemaining.mockRejectedValue(new Error("ECONNRESET"));
    expect((await readRateLimit(AUTH_POLICY, "k")).allowed).toBe(true);
    expect(console.error).toHaveBeenCalled();
  });

  it("swallows a failed refund rather than breaking a successful sign-in", async () => {
    // Leaving the token spent is the safe direction; throwing here would turn a
    // correct password into a 500.
    mocks.resetUsedTokens.mockRejectedValue(new Error("ECONNRESET"));
    await expect(resetRateLimit(AUTH_POLICY, "k")).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });

  it("does not crash the process when the background `pending` promise rejects", async () => {
    // A rejected floating promise is an unhandled rejection, which on Node kills
    // the server — a rate limiter must not be able to take the app down.
    mocks.limit.mockResolvedValue({
      success: true,
      limit: 5,
      remaining: 4,
      reset: Date.now(),
      pending: Promise.reject(new Error("analytics flush failed")),
    });
    const v = await consumeRateLimit(AUTH_POLICY, "k");
    expect(v.allowed).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
  });
});
