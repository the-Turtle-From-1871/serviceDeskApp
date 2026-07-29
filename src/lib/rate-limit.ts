// IP-based rate limiting.
//
// Deliberately import-safe from ANYWHERE that runs on the server: `src/proxy.ts`
// (Next 16 proxy, Node runtime) and Server Actions alike. Same rule as
// `public-access-cookie.ts` — the only imports are the two Upstash SDKs, which
// speak plain `fetch` over HTTPS. Do NOT import Prisma, bcrypt or `server-only`
// here, or the proxy bundle grows a database client.
//
// ── Store ────────────────────────────────────────────────────────────────────
// Upstash Redis when it is configured, an in-process fallback when it is not.
// `@vercel/kv` is deprecated by Vercel ("Vercel KV is deprecated … install a
// Redis integration from Vercel Marketplace"), and the Marketplace Redis
// integration injects `KV_REST_API_URL` / `KV_REST_API_TOKEN` — the very names
// the old KV SDK used. So reading those vars IS "Vercel KV", just through the
// SDK that is still maintained. `UPSTASH_REDIS_REST_*` is accepted too, for a
// store provisioned directly at Upstash rather than through Vercel.
//
// The fallback is a real limiter, not a stub — but its counters live in one
// process, so on Vercel it only throttles requests that land on the same warm
// instance, and the proxy bundle and the Server Action bundle keep SEPARATE
// maps. It exists so dev, CI and the tests exercise the same call sites with no
// infrastructure; it is NOT the production posture. See docs/SECURITY.md.
//
// The two backends are kept semantically identical on the one point where they
// could plausibly differ: a REFUSED attempt is not recorded. Upstash's sliding-
// window Lua script returns before its `INCRBY`, so the fallback does the same.
// The alternative (recording denials, so hammering extends the lockout) is
// defensible, but a limiter that means two different things depending on
// whether Redis happens to be attached is not.
//
// ── Failure mode: OPEN ───────────────────────────────────────────────────────
// A Redis outage lets requests through (logged server-side) rather than locking
// every technician out of the property book. That is a deliberate availability
// choice for an internal tool whose real authz boundary is elsewhere; it is
// recorded under "Known gaps & accepted risks".
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

export type RateLimitPolicy = {
  /** Key namespace. Distinct per policy so the two buckets never collide. */
  readonly name: string;
  /** Requests permitted per window. */
  readonly limit: number;
  readonly windowSeconds: number;
};

/**
 * Auth attempts: 5 per 15 minutes, on the NARROWEST key the call site can
 * build — `(scope, ip, identity)` where an identity is available (the submitted
 * email), `(scope, ip)` where there is none (the reset token, the shared PIN).
 */
export const AUTH_POLICY: RateLimitPolicy = {
  name: "auth",
  limit: 5,
  windowSeconds: 15 * 60,
};

/**
 * The ceiling over a whole IP, for the surfaces whose narrow key includes an
 * attacker-chosen identity.
 *
 * Without it the composite key is a bypass, not a limit: the email is supplied
 * by whoever is submitting the form, so rotating it buys a fresh 5-attempt
 * bucket every time and one host could spray thousands of accounts unmetered.
 * Without the *composite*, meanwhile, a single per-IP bucket punishes the wrong
 * people — the service desk shares one NAT egress IP, so one person fat-
 * fingering their password five times would lock out every colleague behind the
 * same connection.
 *
 * **Spend it only AFTER the narrow bucket has allowed the attempt.** That
 * ordering is what keeps one person from spending everyone's: hammering a
 * single account exhausts that account's five and then stops touching this
 * bucket at all. Reversed, twenty cheap requests naming one address would lock
 * every colleague behind that egress out of sign-in for fifteen minutes — the
 * exact failure the composite key exists to prevent.
 *
 * 60 rather than something tighter because, unlike the narrow bucket, this one
 * is never refunded: it counts *attempts that reached a password*, successes
 * included. A twenty-person desk at shift change is well inside it, and a
 * sprayer is still capped at 60 accounts per 15 minutes per network instead of
 * an unbounded walk through a list.
 */
export const AUTH_SPRAY_POLICY: RateLimitPolicy = {
  name: "auth-spray",
  limit: 60,
  windowSeconds: 15 * 60,
};

/**
 * The public PIN gate: 20 per 15 minutes per IP.
 *
 * Higher than `AUTH_POLICY` because there is no identity to narrow the key
 * with — one 8-digit secret shared org-wide — so this bucket is unavoidably
 * per-NETWORK, and successes count (refunding a shared bucket would let a
 * colleague's correct PIN hand an attacker on the same egress a fresh budget).
 * At 5 the sixth soldier to unlock in a quarter of an hour was refused, and the
 * public surface's entire audience is behind shared egress by design.
 *
 * 20 is still hopeless for an attacker: 20 guesses per 15 minutes against 10^8,
 * on top of the 400ms delay in `unlockAction`, is ~10^5 years of guessing.
 */
export const UNLOCK_POLICY: RateLimitPolicy = {
  name: "unlock",
  limit: 20,
  windowSeconds: 15 * 60,
};

/**
 * Everything else that is worth throttling: 300 per minute per IP.
 *
 * Deliberately above the 100 the sprint named. The same shared-NAT reasoning
 * that exempts signed-in staff applies to the population the public surface
 * EXISTS for: a unit turn-in puts twenty soldiers behind one egress, each
 * loading item pages, receipts and a debounced search, and 100/min divided
 * twenty ways is about five requests per person per minute before everyone
 * starts getting 429s on the pages they were told to use. 300 keeps the
 * anti-scraping intent — a scraper wants thousands — without shipping an
 * outage for the primary use case.
 */
export const API_POLICY: RateLimitPolicy = {
  name: "api",
  limit: 300,
  windowSeconds: 60,
};

export type RateLimitVerdict = {
  /** False means the caller must refuse the request. */
  allowed: boolean;
  limit: number;
  /** Tokens left AFTER this call (never negative). */
  remaining: number;
  /** Epoch ms at which the bucket frees up. */
  resetAt: number;
  /** Whole seconds to put in `Retry-After`; always ≥ 1 when blocked. */
  retryAfterSeconds: number;
};

// ─── Client IP ───────────────────────────────────────────────────────────────

/**
 * Best-effort client IP from request headers.
 *
 * Order matters, and EVERY entry here is a header a client can send. They are
 * trustworthy only because the platform in front of this app overwrites them:
 * `x-vercel-forwarded-for` is stamped by Vercel's edge and cannot be forged
 * through it, so it comes first. `x-forwarded-for` is next, leftmost entry.
 * `x-real-ip` is LAST on purpose — Vercel sets it, but a reverse proxy
 * configured with only `proxy_set_header X-Forwarded-For` does not, and
 * preferring it there would let `curl -H 'x-real-ip: <random>'` mint a fresh
 * bucket per request and walk straight through every limit in this module.
 *
 * Serving this app without such a proxy makes the identifier forgeable in both
 * directions — unlimited guessing for the attacker, and the ability to burn a
 * shared office ceiling on their behalf. Recorded in docs/SECURITY.md under
 * Known gaps rather than pretended away.
 *
 * Returns null when no header identifies the caller (local `next dev`), which
 * callers collapse into a single shared bucket — see `rateLimitKey`.
 */
export function clientIp(headers: Headers): string | null {
  const candidates = [
    headers.get("x-vercel-forwarded-for"),
    headers.get("x-forwarded-for"),
    headers.get("x-real-ip"),
  ];
  for (const raw of candidates) {
    if (!raw) continue;
    // XFF is a list: "client, proxy1, proxy2". The client is leftmost.
    const first = raw.split(",")[0]?.trim();
    if (first) return first;
  }
  return null;
}

/**
 * Namespaced bucket key. A null IP becomes the literal `unknown` bucket rather
 * than being waved through — otherwise "send no XFF header" would be a bypass.
 * Locally that means every request shares one bucket, which is the intended
 * (conservative) reading of an unidentifiable caller.
 *
 * `scope` separates capabilities that should not share a budget. It must NOT be
 * used to split one capability across surfaces: sign-in is reachable both as a
 * Server Action and as `POST /api/auth/callback/credentials`, and giving those
 * two paths different scopes would hand an attacker ten guesses per window
 * while every document said five. Both use `"login"`.
 *
 * `identity` narrows the bucket to one account within one network — see
 * `AUTH_SPRAY_POLICY` for why that is always paired with a per-IP ceiling. Pass
 * it through `rateLimitIdentity` first; a raw email must never become a Redis
 * key.
 */
export function rateLimitKey(
  policy: RateLimitPolicy,
  ip: string | null,
  scope?: string,
  identity?: string,
): string {
  return [policy.name, scope, ip ?? "unknown", identity].filter(Boolean).join(":");
}

/**
 * Hash a submitted identifier (an email) into a short opaque key fragment.
 *
 * The raw value is deliberately never stored: bucket keys live in a third-party
 * Redis and in logs, and "who tried to sign in as whom" is exactly the kind of
 * PII this app minimises elsewhere. Truncated to 64 bits — a collision merely
 * makes two accounts share one bucket for 15 minutes, which costs nothing.
 *
 * Web Crypto only, like `public-access-cookie.ts`: `node:crypto` must not reach
 * the proxy bundle.
 */
export async function rateLimitIdentity(value: string | null | undefined): Promise<string> {
  const normalized = (value ?? "").trim().toLowerCase();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return Array.from(new Uint8Array(digest).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─── Backends ────────────────────────────────────────────────────────────────

// `allowed` is the backend's own answer, not something derived from
// `remaining`: a sliding window's "did this hit fit?" and "how many are left?"
// are separate questions, and re-deriving one from the other is where
// off-by-one bugs live.
type Reading = { allowed: boolean; limit: number; remaining: number; resetAt: number };

type Backend = {
  /** Spend one token. */
  consume(policy: RateLimitPolicy, key: string): Promise<Reading>;
  /** Empty the bucket — see `resetRateLimit`. */
  reset(policy: RateLimitPolicy, key: string): Promise<void>;
  /** Read without spending — see `readRateLimit`. */
  read(policy: RateLimitPolicy, key: string): Promise<Reading>;
};

function upstashCredentials(): { url: string; token: string } | null {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

/** True when a shared, cross-instance store is configured. */
export function rateLimitStoreConfigured(): boolean {
  return upstashCredentials() !== null;
}

// Built lazily and memoized per policy: constructing at module load would read
// env before the test harness can stub it, and would throw on a deploy that has
// no store configured — which must degrade, not crash.
const upstashLimiters = new Map<string, Ratelimit>();
let upstashRedis: Redis | null = null;
let upstashRedisFor: string | null = null;

/** Only ever called from `upstashBackend`, which `backend()` gates on credentials. */
function upstashLimiter(policy: RateLimitPolicy): Ratelimit {
  const creds = upstashCredentials();
  if (!creds) throw new Error("rate-limit: no Upstash credentials");
  // Credentials rotating at runtime is not a thing we support, but keying the
  // cached client on the URL means a stubbed test env cannot leak a client
  // built for a different store into the next test.
  if (upstashRedisFor !== creds.url || !upstashRedis) {
    upstashRedis = new Redis({ url: creds.url, token: creds.token });
    upstashRedisFor = creds.url;
    upstashLimiters.clear();
  }
  const cached = upstashLimiters.get(policy.name);
  if (cached) return cached;
  const limiter = new Ratelimit({
    redis: upstashRedis,
    // Sliding window: no burst at the window boundary, which a fixed window
    // would allow (2× the limit across two adjacent windows).
    limiter: Ratelimit.slidingWindow(policy.limit, `${policy.windowSeconds} s`),
    // Off on purpose: analytics writes extra Redis keys per request and leaves
    // a `pending` promise the caller must drain. We want the cheapest possible
    // check on the hot path.
    analytics: false,
    prefix: `handreceipt:rl:${policy.name}`,
  });
  upstashLimiters.set(policy.name, limiter);
  return limiter;
}

const upstashBackend: Backend = {
  async consume(policy, key) {
    const res = await upstashLimiter(policy).limit(key);
    // Nothing is scheduled behind `pending` with analytics off and a single
    // region, but a floating rejected promise would still crash the process.
    void Promise.resolve(res.pending).catch(() => {});
    return {
      allowed: res.success,
      limit: res.limit,
      remaining: Math.max(0, res.remaining),
      resetAt: res.reset,
    };
  },
  async reset(policy, key) {
    await upstashLimiter(policy).resetUsedTokens(key);
  },
  async read(policy, key) {
    const res = await upstashLimiter(policy).getRemaining(key);
    return {
      allowed: res.remaining > 0,
      limit: res.limit,
      remaining: Math.max(0, res.remaining),
      resetAt: res.reset,
    };
  },
};

// In-process sliding window. Each key holds the timestamps of the PERMITTED
// hits still inside the window; anything older is dropped on read. Because a
// refused attempt is not recorded (see the header comment), an array can never
// exceed `policy.limit` entries — 5 or 100 — so a flood cannot turn the limiter
// itself into the amplifier by making every subsequent request filter a
// million-element array.
const memoryHits = new Map<string, number[]>();

// Distinct IPs still accumulate keys, so the map is swept — but on a timer
// rather than on a size threshold. A threshold is a cliff: once the map is
// large enough to trip it and full of live buckets, every single request pays
// an O(keys) scan that deletes nothing.
const MEMORY_SWEEP_INTERVAL_MS = 60_000;
let lastMemorySweepAt = 0;

function memoryWindow(policy: RateLimitPolicy, key: string, now: number): number[] {
  const cutoff = now - policy.windowSeconds * 1000;
  const kept = (memoryHits.get(key) ?? []).filter((t) => t > cutoff);
  if (kept.length) memoryHits.set(key, kept);
  else memoryHits.delete(key);
  return kept;
}

// The longest window any policy uses bounds how long an entry can matter.
// OBSERVED rather than written down: policies live in more than one module
// (`auth-velocity.ts` defines its own), so a hardcoded max would be a silent
// trap — too small, and the sweep deletes live buckets. Too large is harmless,
// it only keeps dead entries around a little longer.
let longestWindowSeconds = 0;

function memorySweep(now: number) {
  if (now - lastMemorySweepAt < MEMORY_SWEEP_INTERVAL_MS) return;
  lastMemorySweepAt = now;
  const cutoff = now - longestWindowSeconds * 1000;
  for (const [key, hits] of memoryHits) {
    if (!hits.some((t) => t > cutoff)) memoryHits.delete(key);
  }
}

function memoryReading(
  policy: RateLimitPolicy,
  hits: number[],
  now: number,
  allowed: boolean,
): Reading {
  // The oldest hit, because `consume` refuses before pushing once the array is
  // full — so it can never hold more than `policy.limit` entries and the
  // "limit-th newest" is always the first. (An earlier version generalised this
  // to `hits[hits.length - limit]`, which read as prudent but described a state
  // the module structurally prevents; dead arithmetic beside a comment
  // explaining it is how the next reader gets talked into loosening the bound.)
  const pivot = hits[0];
  return {
    allowed,
    limit: policy.limit,
    remaining: Math.max(0, policy.limit - hits.length),
    resetAt: pivot === undefined ? now : pivot + policy.windowSeconds * 1000,
  };
}

const memoryBackend: Backend = {
  async consume(policy, key) {
    const now = Date.now();
    longestWindowSeconds = Math.max(longestWindowSeconds, policy.windowSeconds);
    memorySweep(now);
    const hits = memoryWindow(policy, key, now);
    if (hits.length >= policy.limit) return memoryReading(policy, hits, now, false);
    hits.push(now);
    memoryHits.set(key, hits);
    return memoryReading(policy, hits, now, true);
  },
  async reset(_policy, key) {
    memoryHits.delete(key);
  },
  async read(policy, key) {
    const now = Date.now();
    const hits = memoryWindow(policy, key, now);
    return memoryReading(policy, hits, now, hits.length < policy.limit);
  },
};

let warnedAboutFallback = false;

function backend(): Backend {
  if (rateLimitStoreConfigured()) return upstashBackend;
  if (!warnedAboutFallback) {
    warnedAboutFallback = true;
    console.warn(
      "[rate-limit] No Redis configured (KV_REST_API_URL/KV_REST_API_TOKEN); " +
        "falling back to per-instance in-memory counters. Not a production posture.",
    );
  }
  return memoryBackend;
}

/**
 * Test seam: how many hits the in-memory backend is holding for a key. Exists
 * so a test can assert the array is BOUNDED — the failure it guards (a flood
 * growing one array without limit, re-filtered per request) is invisible from
 * the outside until it is a production incident.
 */
export function __memoryHitCountForTests(key: string): number {
  return memoryHits.get(key)?.length ?? 0;
}

/** Test seam: drop the in-memory counters and the memoized clients. */
export function __resetRateLimitStateForTests() {
  memoryHits.clear();
  lastMemorySweepAt = 0;
  longestWindowSeconds = 0;
  upstashLimiters.clear();
  upstashRedis = null;
  upstashRedisFor = null;
  warnedAboutFallback = false;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Disable switch for local work. Never set this in a deployed environment.
 *
 * Exported because `src/proxy.ts` gates its User-Agent filter on the same
 * switch; a second copy of the env-var name meant renaming it would silently
 * disable only half the anti-abuse surface.
 */
export function rateLimitDisabled(): boolean {
  return process.env.RATE_LIMIT_DISABLED === "true";
}
const disabled = rateLimitDisabled;

function allow(policy: RateLimitPolicy): RateLimitVerdict {
  return {
    allowed: true,
    limit: policy.limit,
    remaining: policy.limit,
    resetAt: Date.now(),
    retryAfterSeconds: 0,
  };
}

function verdict(reading: Reading): RateLimitVerdict {
  const retryMs = Math.max(0, reading.resetAt - Date.now());
  return {
    allowed: reading.allowed,
    limit: reading.limit,
    remaining: reading.remaining,
    resetAt: reading.resetAt,
    // Ceil, and never 0 when blocked: `Retry-After: 0` reads as "retry now",
    // which is the one thing a blocked caller must not do.
    retryAfterSeconds: reading.allowed ? 0 : Math.max(1, Math.ceil(retryMs / 1000)),
  };
}

/**
 * Human phrasing for a `Retry-After`, for form errors. Rounded UP and kept
 * vague ("about"), so it never promises an earlier retry than the bucket will
 * actually honour.
 */
export function formatRetryAfter(seconds: number): string {
  // `< 60`, not `<= 60`: at exactly 60 the bucket is a full minute away, and
  // "in less than a minute" would be the earlier retry this function promises
  // never to name.
  if (seconds < 60) return "in less than a minute";
  const minutes = Math.ceil(seconds / 60);
  return `in about ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/**
 * Spend one token against `policy` for `key`.
 *
 * ALWAYS call this BEFORE the work being protected, never after deciding the
 * work failed. Spending afterwards is a time-of-check/time-of-use hole with a
 * window exactly as wide as the operation it guards: 500 concurrent sign-ins
 * would all read the same untouched bucket during the ~250ms bcrypt compare and
 * all be admitted, turning "5 guesses per 15 minutes" into "5 guesses per
 * 15 minutes times the attacker's parallelism".
 *
 * Fails OPEN: a store error is logged and the request is allowed.
 */
export async function consumeRateLimit(
  policy: RateLimitPolicy,
  key: string,
): Promise<RateLimitVerdict> {
  if (disabled()) return allow(policy);
  try {
    return verdict(await backend().consume(policy, key));
  } catch (err) {
    console.error("[rate-limit] store unavailable; allowing request", err);
    return allow(policy);
  }
}

/**
 * Read a bucket WITHOUT spending a token.
 *
 * ADVISORY ONLY. Never gate admission on this — that is precisely the
 * time-of-check/time-of-use hole `consumeRateLimit` documents. It exists for
 * the global botnet detector (`src/lib/auth-velocity.ts`), which needs to know
 * the current state at the *start* of a request, before the outcome that would
 * update it is known. Being one attempt stale there costs nothing.
 *
 * Fails OPEN, reporting "not elevated", so a store outage cannot make the app
 * behave as though it were under attack.
 */
export async function readRateLimit(
  policy: RateLimitPolicy,
  key: string,
): Promise<RateLimitVerdict> {
  if (disabled()) return allow(policy);
  try {
    return verdict(await backend().read(policy, key));
  } catch (err) {
    console.error("[rate-limit] store unavailable; reporting an empty bucket", err);
    return allow(policy);
  }
}

/**
 * Empty a bucket. Call it when an attempt SUCCEEDS.
 *
 * This is what keeps the auth limit a *failure* budget while still spending the
 * token up front (see `consumeRateLimit`): the attempt is charged before the
 * password check, and given back once it turns out to have been the right
 * password.
 *
 * ⚠️ **Only ever call this on a bucket keyed to the caller's own identity** —
 * `(scope, ip, hashed-email)`. Never on a SHARED bucket such as
 * `AUTH_SPRAY_POLICY`'s `(scope, ip)`: emptying that would let anyone holding
 * one valid credential clear the whole network's ceiling between guesses, which
 * turns the ceiling into decoration.
 *
 * ⚠️ **Cost.** On Upstash this is `resetUsedTokens`, which runs a Lua script
 * that `SCAN`s for `<prefix>:<identifier>:*` — O(keyspace), not O(1). It is
 * therefore called only on SUCCESS, an event that happens tens of times a day,
 * never on the failure path an attacker controls. Do not move it onto a hot
 * path. That pattern is also why an identifier must not be a prefix of another:
 * resetting `auth:login:<ip>` would delete every `auth:login:<ip>:<account>`
 * bucket beneath it. Today no scope mixes the two shapes under one policy.
 *
 * Best-effort. A failure to reset leaves the token spent, which is the safe
 * direction, so it is logged and swallowed.
 */
export async function resetRateLimit(policy: RateLimitPolicy, key: string): Promise<void> {
  if (disabled()) return;
  try {
    await backend().reset(policy, key);
  } catch (err) {
    console.error("[rate-limit] could not reset bucket", err);
  }
}
