import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  API_POLICY,
  AUTH_POLICY,
  AUTH_SPRAY_POLICY,
  __memoryHitCountForTests,
  __resetRateLimitStateForTests,
  clientIp,
  consumeRateLimit,
  formatRetryAfter,
  rateLimitIdentity,
  rateLimitKey,
  rateLimitStoreConfigured,
  resetRateLimit,
} from "./rate-limit";

// No KV_* env in .env.test, so every test here exercises the in-memory backend
// — which is the point: it is the code path dev, CI and the Server Action tests
// actually run, so it has to be a real limiter rather than a stub.
beforeEach(() => {
  __resetRateLimitStateForTests();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
  __resetRateLimitStateForTests();
});

describe("clientIp", () => {
  it("prefers the platform-stamped header over anything the client can set", () => {
    const h = new Headers({
      "x-vercel-forwarded-for": "9.9.9.9",
      "x-real-ip": "8.8.8.8",
      "x-forwarded-for": "1.2.3.4",
    });
    expect(clientIp(h)).toBe("9.9.9.9");
  });

  it("takes the LEFTMOST entry of an X-Forwarded-For chain", () => {
    // "client, proxy1, proxy2" — picking the last would bucket every visitor
    // behind our own edge into one key and throttle the whole internet at once.
    const h = new Headers({ "x-forwarded-for": "1.2.3.4, 10.0.0.1, 10.0.0.2" });
    expect(clientIp(h)).toBe("1.2.3.4");
  });

  it("returns null when nothing identifies the caller", () => {
    expect(clientIp(new Headers())).toBeNull();
  });

  it("skips a blank header instead of returning an empty identifier", () => {
    // An empty XFF would otherwise produce the key "auth:" — a second anonymous
    // bucket distinct from "unknown", i.e. a free extra five attempts.
    const h = new Headers({ "x-forwarded-for": " ", "x-real-ip": "8.8.8.8" });
    expect(clientIp(h)).toBe("8.8.8.8");
  });
});

describe("rateLimitKey", () => {
  it("namespaces by policy and scope so buckets never collide", () => {
    expect(rateLimitKey(AUTH_POLICY, "1.2.3.4", "login")).toBe("auth:login:1.2.3.4");
    expect(rateLimitKey(API_POLICY, "1.2.3.4")).toBe("api:1.2.3.4");
  });

  it("collapses an unidentifiable caller into one bucket rather than waving it through", () => {
    expect(rateLimitKey(AUTH_POLICY, null, "login")).toBe("auth:login:unknown");
  });

  it("narrows to one account within one network when an identity is given", () => {
    expect(rateLimitKey(AUTH_POLICY, "1.2.3.4", "login", "abc123")).toBe(
      "auth:login:1.2.3.4:abc123",
    );
  });
});

describe("rateLimitIdentity", () => {
  it("never puts a raw address in the key", async () => {
    // Bucket keys live in a third-party Redis and in logs; "who tried to sign in
    // as whom" is exactly the PII this app minimises elsewhere.
    const id = await rateLimitIdentity("Tech@Example.com");
    expect(id).not.toContain("@");
    expect(id).not.toContain("example");
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("normalises case and surrounding space, so one account is one bucket", async () => {
    // Emails are case-insensitive here (`User.email` is citext and the login
    // schema lowercases), so "Tech@x" and "tech@x" must not be two budgets.
    expect(await rateLimitIdentity("  Tech@Example.com ")).toBe(
      await rateLimitIdentity("tech@example.com"),
    );
  });

  it("keeps different accounts apart", async () => {
    expect(await rateLimitIdentity("a@example.com")).not.toBe(
      await rateLimitIdentity("b@example.com"),
    );
  });

  it("gives a blank identity a stable bucket rather than throwing", async () => {
    expect(await rateLimitIdentity(null)).toBe(await rateLimitIdentity(""));
  });
});

describe("the composite key and its ceiling", () => {
  // The pair is the point: neither half works alone, and the ORDER they are
  // spent in decides whether the pair protects people or locks them out.
  const ip = "7.7.7.7";
  const narrow = async (email: string) =>
    rateLimitKey(AUTH_POLICY, ip, "login", await rateLimitIdentity(email));
  const spray = rateLimitKey(AUTH_SPRAY_POLICY, ip, "login");

  it("gives each account its own five tries from the same network", async () => {
    // Without this, one person mistyping their password five times would lock
    // out every colleague behind the same NAT egress IP.
    for (let i = 0; i < AUTH_POLICY.limit; i++) {
      await consumeRateLimit(AUTH_POLICY, await narrow("alice@example.com"));
    }
    expect((await consumeRateLimit(AUTH_POLICY, await narrow("alice@example.com"))).allowed).toBe(
      false,
    );
    expect((await consumeRateLimit(AUTH_POLICY, await narrow("bob@example.com"))).allowed).toBe(
      true,
    );
  });

  it("still stops one host spraying a list of accounts", async () => {
    // The composite key is attacker-controlled — a new email mints a new bucket
    // — so on its own it is a bypass, not a limit. The per-IP ceiling is what
    // makes it a limit.
    for (let i = 0; i < AUTH_SPRAY_POLICY.limit; i++) {
      const v = await consumeRateLimit(AUTH_SPRAY_POLICY, spray);
      expect(v.allowed, `victim ${i + 1}`).toBe(true);
      // Each name gets a pristine narrow bucket, which is exactly the problem.
      expect((await consumeRateLimit(AUTH_POLICY, await narrow(`v${i}@example.com`))).allowed).toBe(
        true,
      );
    }
    expect((await consumeRateLimit(AUTH_SPRAY_POLICY, spray)).allowed).toBe(false);
  });

  it("sets the ceiling above the per-account budget, or the composite is dead weight", () => {
    // If the two limits were equal the narrow bucket could never bind first and
    // the composite would do nothing at all.
    expect(AUTH_SPRAY_POLICY.limit).toBeGreaterThan(AUTH_POLICY.limit);
    expect(AUTH_SPRAY_POLICY.windowSeconds).toBe(AUTH_POLICY.windowSeconds);
  });
});

describe("resetRateLimit", () => {
  it("gives the whole bucket back", async () => {
    const key = rateLimitKey(AUTH_POLICY, "4.4.4.1", "login");
    for (let i = 0; i < AUTH_POLICY.limit; i++) await consumeRateLimit(AUTH_POLICY, key);
    expect((await consumeRateLimit(AUTH_POLICY, key)).allowed).toBe(false);

    await resetRateLimit(AUTH_POLICY, key);

    for (let i = 0; i < AUTH_POLICY.limit; i++) {
      expect((await consumeRateLimit(AUTH_POLICY, key)).allowed, `attempt ${i + 1}`).toBe(true);
    }
  });

  it("resets only the bucket it names", async () => {
    const mine = rateLimitKey(AUTH_POLICY, "4.4.4.2", "login");
    const theirs = rateLimitKey(AUTH_POLICY, "4.4.4.3", "login");
    for (let i = 0; i < AUTH_POLICY.limit; i++) await consumeRateLimit(AUTH_POLICY, theirs);
    await resetRateLimit(AUTH_POLICY, mine);
    expect((await consumeRateLimit(AUTH_POLICY, theirs)).allowed).toBe(false);
  });

  it("is a no-op on a bucket that was never used", async () => {
    await expect(resetRateLimit(AUTH_POLICY, "auth:login:nobody")).resolves.toBeUndefined();
  });
});

describe("configuration", () => {
  it("reports no shared store when neither env pair is set", () => {
    expect(rateLimitStoreConfigured()).toBe(false);
  });

  it("accepts the Vercel Marketplace KV_* names and the native UPSTASH_* names", () => {
    vi.stubEnv("KV_REST_API_URL", "https://example.upstash.io");
    vi.stubEnv("KV_REST_API_TOKEN", "token");
    expect(rateLimitStoreConfigured()).toBe(true);
    vi.unstubAllEnvs();

    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.upstash.io");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "token");
    expect(rateLimitStoreConfigured()).toBe(true);
  });

  it("needs BOTH halves of a credential pair", () => {
    vi.stubEnv("KV_REST_API_URL", "https://example.upstash.io");
    expect(rateLimitStoreConfigured()).toBe(false);
  });

  it("RATE_LIMIT_DISABLED short-circuits the limiter", async () => {
    vi.stubEnv("RATE_LIMIT_DISABLED", "true");
    const key = rateLimitKey(AUTH_POLICY, "3.3.3.3", "login");
    for (let i = 0; i < AUTH_POLICY.limit * 3; i++) {
      expect((await consumeRateLimit(AUTH_POLICY, key)).allowed).toBe(true);
    }
  });
});

describe("formatRetryAfter", () => {
  it("rounds up and never promises an earlier retry than the bucket honours", () => {
    expect(formatRetryAfter(1)).toBe("in less than a minute");
    expect(formatRetryAfter(59)).toBe("in less than a minute");
    // Exactly 60 is a FULL minute away — "in less than a minute" would be the
    // earlier retry this function promises never to name.
    expect(formatRetryAfter(60)).toBe("in about 1 minute");
    expect(formatRetryAfter(61)).toBe("in about 2 minutes");
    expect(formatRetryAfter(120)).toBe("in about 2 minutes");
    expect(formatRetryAfter(15 * 60)).toBe("in about 15 minutes");
  });
});
