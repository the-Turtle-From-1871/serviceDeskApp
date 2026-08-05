import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// `auth()` wraps the handler and pulls in Prisma; stub it so the proxy's own
// logic can be exercised without a database. The wrapper's only contract here
// is "call my handler with a request carrying `.auth`".
vi.mock("@/auth", () => ({
  auth: (handler: (req: NextRequest & { auth: unknown }) => unknown) => handler,
}));

import { proxy, config } from "./proxy";
import {
  signUnlockValue,
  unlockCookieName,
  UNLOCK_TTL_MS,
  UNLOCK_CLOCK_SKEW_MS,
} from "@/lib/public-access-cookie";
import {
  API_POLICY,
  AUTH_POLICY,
  AUTH_SPRAY_POLICY,
  __memoryHitCountForTests,
  __resetRateLimitStateForTests,
  consumeRateLimit,
  rateLimitKey,
} from "@/lib/rate-limit";
import {
  receiptGrantCookieName,
  receiptGrantValue,
  signReceiptLinkToken,
} from "@/lib/receipt-link-token";

const SECRET = "test-secret";

/** Build a request for the public PII surface, optionally carrying a cookie. */
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";

const request = (
  opts: { path?: string; cookie?: string; secure?: boolean; cookies?: Record<string, string> } = {},
) => {
  // The public surface now refuses anonymous requests that do not present as a
  // browser, and that check runs BEFORE the PIN gate — so these fixtures need a
  // User-Agent or they would all assert 403 instead of what they are about.
  const headers = new Headers({ "user-agent": BROWSER_UA });
  const jar: string[] = [];
  if (opts.cookie !== undefined) {
    jar.push(`${unlockCookieName(opts.secure ?? false)}=${opts.cookie}`);
  }
  for (const [name, value] of Object.entries(opts.cookies ?? {})) jar.push(`${name}=${value}`);
  if (jar.length) headers.set("cookie", jar.join("; "));
  const req = new NextRequest(`https://example.test${opts.path ?? "/i/abc"}`, { headers });
  // Logged out — the PIN gate only applies to anonymous visitors.
  Object.defineProperty(req, "auth", { value: null, configurable: true });
  return req as NextRequest & { auth: null };
};

const run = (req: NextRequest & { auth: null }) =>
  (proxy as unknown as (r: NextRequest) => Promise<Response>)(req);

beforeEach(() => {
  vi.stubEnv("PUBLIC_ACCESS_PIN_ENABLED", "true");
  vi.stubEnv("AUTH_SECRET", SECRET);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  // The proxy now spends a rate-limit token per request. Without this reset the
  // in-memory buckets carry across tests — every request here has no IP header,
  // so they all share the "unknown" bucket — and a later test would fail with a
  // 429 for reasons that have nothing to do with what it asserts.
  __resetRateLimitStateForTests();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  __resetRateLimitStateForTests();
});

describe("proxy — public PIN gate", () => {
  it("lets a validly unlocked visitor through without touching their cookie", async () => {
    const value = await signUnlockValue(Date.now() + UNLOCK_TTL_MS, SECRET);
    const res = await run(request({ cookie: value }));
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("lets a validly unlocked visitor through IN PRODUCTION, reading the __Secure- cookie", async () => {
    // The accept path under the prefix had no coverage, and its failure mode is
    // invisible: if the prod cookie name or read path regressed, every unlocked
    // visitor would be redirected to /unlock forever — the same outcome the
    // refusal test expects, so the suite would stay green. Prod-only,
    // prefix-related blind spots are exactly what this branch already shipped
    // once.
    vi.stubEnv("NODE_ENV", "production");
    const value = await signUnlockValue(Date.now() + UNLOCK_TTL_MS, SECRET);
    const res = await run(request({ cookie: value, secure: true }));
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("redirects an anonymous visitor to /unlock", async () => {
    const res = await run(request());
    expect(res.headers.get("location")).toContain("/unlock");
  });

  it("sends NO Set-Cookie when the visitor presented no cookie", async () => {
    // An unconditional delete would land on a request already in flight from
    // another tab and wipe a cookie the user had just legitimately minted.
    const res = await run(request());
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("expires a refused cookie with the Secure ATTRIBUTE in production", async () => {
    // The regression this pins: `cookies.delete(name)` omits Secure, and a
    // Set-Cookie whose name carries the `__Secure-` prefix without that
    // attribute is rejected outright by browsers — so the retirement silently
    // did nothing in the only environment that uses the prefix.
    //
    // Matched as an ATTRIBUTE (`; Secure`), never as a substring: the cookie is
    // NAMED `__Secure-pub_unlock`, so a bare toContain("Secure") passes on the
    // name alone and cannot fail. (Path needs no assertion — Next's
    // normalizeCookie defaults it to "/" either way.)
    vi.stubEnv("NODE_ENV", "production");
    const stale = await signUnlockValue(
      Date.now() + UNLOCK_TTL_MS + UNLOCK_CLOCK_SKEW_MS + 60_000,
      SECRET,
    );
    const res = await run(request({ cookie: stale, secure: true }));

    expect(res.headers.get("location")).toContain("/unlock");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(unlockCookieName(true));
    expect(setCookie).toMatch(/;\s*Secure(\s*;|\s*$)/);
    expect(setCookie).toMatch(/;\s*HttpOnly(\s*;|\s*$)/);
    expect(setCookie).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/);
  });

  it("expires a refused cookie outside production too", async () => {
    const stale = await signUnlockValue(
      Date.now() + UNLOCK_TTL_MS + UNLOCK_CLOCK_SKEW_MS + 60_000,
      SECRET,
    );
    const res = await run(request({ cookie: stale }));
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(unlockCookieName(false));
    expect(setCookie).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/);
  });

  it("does NOT gate the home page, even with the PIN flag on and no cookie", async () => {
    // `/` is the page that explains what this application is, and it has to be
    // readable by a stranger — Google's OAuth branding verification refused the
    // app because the home page redirected to this 8-digit PIN prompt. It is
    // exempt from the PIN gate, NOT from the login gate's default-deny: assert
    // it goes to neither, since falling through to the wrong branch would send
    // it to /login and look just as broken.
    const res = await run(request({ path: "/" }));
    expect(res.headers.get("location")).toBeNull();
    expect(res.status).not.toBe(403);
  });

  it("still gates item and receipt pages the home page links to", async () => {
    // The exemption above is scoped to `/` alone. If it ever widens, the PIN
    // gate is gone — the home page's whole purpose is linking to these.
    for (const path of ["/i/abc", "/receipts/HR-000001", "/receipts/HR-000001/pdf"]) {
      expect((await run(request({ path }))).headers.get("location"), path).toContain("/unlock");
    }
  });

  it("refuses everyone when AUTH_SECRET is missing, rather than admitting them", async () => {
    // Fail CLOSED: with a blank key the expected MAC is hmac("", exp), which an
    // attacker can compute offline.
    const value = await signUnlockValue(Date.now() + UNLOCK_TTL_MS, SECRET);
    vi.stubEnv("AUTH_SECRET", "");
    const res = await run(request({ cookie: value }));
    expect(res.headers.get("location")).toContain("/unlock");
  });
});

describe("proxy — rate limiting", () => {
  /** A request with a real client IP, so each test gets its own bucket. */
  const ipRequest = (opts: {
    path: string;
    ip: string;
    method?: string;
    loggedIn?: boolean;
    userAgent?: string | null;
  }) => {
    const headers = new Headers({ "x-forwarded-for": opts.ip });
    // A browser-shaped UA by default: the public surface now refuses requests
    // that do not present as a browser, so without this every rate-limit test
    // below would be asserting 403s.
    if (opts.userAgent !== null) {
      headers.set(
        "user-agent",
        opts.userAgent ??
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36",
      );
    }
    const req = new NextRequest(`https://example.test${opts.path}`, {
      headers,
      method: opts.method ?? "GET",
    });
    Object.defineProperty(req, "auth", {
      value: opts.loggedIn ? { user: { id: "u1" } } : null,
      configurable: true,
    });
    return req as NextRequest & { auth: unknown };
  };

  const runIp = (req: NextRequest & { auth: unknown }) =>
    (proxy as unknown as (r: NextRequest) => Promise<Response>)(req);

  describe("/api/auth/*", () => {
    it("CLOSES the credentials callback rather than merely throttling it", async () => {
      // It is a fully working second front door to the credential check, and one
      // this app never uses (`loginAction` calls `signIn()` in process). Left
      // open it walked around all three protections layered onto the Server
      // Action: the Turnstile challenge, the per-account composite bucket, and
      // the global botnet counter that only `loginAction` feeds. A distributed
      // attack driving this path would have produced no velocity signal at all.
      const res = await runIp(
        ipRequest({ path: "/api/auth/callback/credentials", ip: "5.0.0.1", method: "POST" }),
      );
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
    });

    it("closes it no matter how many times it is asked", async () => {
      // Not a rate limit that lets the first five through.
      for (let i = 0; i < 10; i++) {
        const res = await runIp(
          ipRequest({ path: "/api/auth/callback/credentials", ip: "5.0.0.9", method: "POST" }),
        );
        expect(res.status, `attempt ${i + 1}`).toBe(404);
      }
    });

    it("still allows a GET of the callback path", async () => {
      // OAuth-style callbacks arrive as GETs; only the credential POST is the
      // second front door. Closing reads would break a provider added later.
      const res = await runIp(ipRequest({ path: "/api/auth/callback/whatever", ip: "5.0.0.10" }));
      expect(res.status).not.toBe(404);
    });

    it("meters other mutations on the per-network ceiling", async () => {
      const attempt = () =>
        runIp(ipRequest({ path: "/api/auth/signout", ip: "5.0.0.1", method: "POST" }));
      for (let i = 0; i < AUTH_SPRAY_POLICY.limit; i++) {
        expect((await attempt()).status, `attempt ${i + 1}`).not.toBe(429);
      }
      const blocked = await attempt();
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
      expect(blocked.headers.get("cache-control")).toBe("no-store");
    });

    it("does not charge reads to the sign-in budget", async () => {
      // GET /api/auth/session and /csrf are how the client discovers state; if
      // they spent from the sign-in bucket, an ordinary page could exhaust a
      // user's budget before they typed a password.
      //
      // Asserted against the bucket ITSELF, not against a follow-up request to
      // the credentials callback: that path is unconditionally 404 (two tests
      // above pin it), so a request there can never return 429 and the
      // assertion could not fail no matter what the reads charged.
      const ip = "5.0.0.2";
      for (let i = 0; i < AUTH_SPRAY_POLICY.limit + 3; i++) {
        expect((await runIp(ipRequest({ path: "/api/auth/session", ip }))).status).not.toBe(429);
      }
      expect(__memoryHitCountForTests(rateLimitKey(AUTH_SPRAY_POLICY, ip, "login"))).toBe(0);
      expect(__memoryHitCountForTests(rateLimitKey(AUTH_POLICY, ip, "login"))).toBe(0);
    });

    it("still meters reads under the general policy", async () => {
      // They used to be exempt from BOTH policies — the one route in the app an
      // unauthenticated caller could hammer without limit.
      const ip = "5.0.0.7";
      for (let i = 0; i < API_POLICY.limit; i++) {
        expect((await runIp(ipRequest({ path: "/api/auth/session", ip }))).status).not.toBe(429);
      }
      expect((await runIp(ipRequest({ path: "/api/auth/session", ip }))).status).toBe(429);
    });

    it("never sends the auth endpoint to the login gate", async () => {
      // Regression guard for the matcher change: `api/auth` used to be excluded
      // from the proxy entirely. If it now fell through to the coarse login
      // gate, signing in would redirect to /login forever.
      const res = await runIp(ipRequest({ path: "/api/auth/session", ip: "5.0.0.3" }));
      expect(res.headers.get("location")).toBeNull();
      expect(res.status).not.toBe(429);
    });

    it("matches on a path SEGMENT, so a future /api/authors is not exempt", async () => {
      // `startsWith("/api/auth")` would swallow it — skipping the login gate
      // AND both limiters for a route nobody meant to exempt.
      const res = await runIp(ipRequest({ path: "/api/authors", ip: "5.0.0.8" }));
      expect(res.headers.get("location")).toContain("/login");
    });

    it("keeps each IP in its own bucket", async () => {
      for (let i = 0; i < AUTH_SPRAY_POLICY.limit + 1; i++) {
        await runIp(ipRequest({ path: "/api/auth/signout", ip: "5.0.0.4", method: "POST" }));
      }
      const other = await runIp(
        ipRequest({ path: "/api/auth/signout", ip: "5.0.0.5", method: "POST" }),
      );
      expect(other.status).not.toBe(429);
    });
  });

  describe("the public surface", () => {
    beforeEach(() => {
      // Off, so a permitted request returns next() rather than a /unlock
      // redirect and the assertions are about the limiter alone.
      vi.stubEnv("PUBLIC_ACCESS_PIN_ENABLED", "false");
    });

    it("throttles anonymous scraping of item pages at API_POLICY.limit per IP", async () => {
      const hit = () => runIp(ipRequest({ path: "/i/abc", ip: "6.0.0.1" }));
      for (let i = 0; i < API_POLICY.limit; i++) {
        expect((await hit()).status, `request ${i + 1}`).not.toBe(429);
      }
      const blocked = await hit();
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get("x-ratelimit-limit")).toBe(String(API_POLICY.limit));
    });

    it("counts a request the PIN gate refuses", async () => {
      vi.stubEnv("PUBLIC_ACCESS_PIN_ENABLED", "true");
      const hit = () => runIp(ipRequest({ path: "/receipts/HR-000001", ip: "6.0.0.2" }));
      for (let i = 0; i < API_POLICY.limit; i++) {
        expect((await hit()).headers.get("location")).toContain("/unlock");
      }
      expect((await hit()).status).toBe(429);
    });

    it("does NOT throttle a signed-in technician on the public routes", async () => {
      // The load-bearing exemption. `/items` links to `/i/<id>` for every row on
      // the page and Next prefetches those links in production — the proxy runs
      // on prefetches too. One technician scrolling a page of inventory would
      // spend ~50 tokens, and the whole desk shares one NAT egress IP, so a few
      // people browsing at once would 429 each other out of the app.
      for (let i = 0; i < API_POLICY.limit + 50; i++) {
        const res = await runIp(ipRequest({ path: "/i/abc", ip: "6.0.0.4", loggedIn: true }));
        expect(res.status, `request ${i + 1}`).not.toBe(429);
      }
      // …and the anonymous budget for that IP is untouched, so the exemption is
      // a skip rather than a silently-refunded spend.
      for (let i = 0; i < API_POLICY.limit; i++) {
        expect((await runIp(ipRequest({ path: "/i/abc", ip: "6.0.0.4" }))).status).not.toBe(429);
      }
    });

    it("does NOT treat the staff builder or a return as public", async () => {
      // `/receipts/` as a bare prefix swallowed `/receipts/new` (the staff hand-
      // receipt builder) and `/receipts/<n>/return` (admin-only), so an
      // anonymous colleague following a bookmarked link met a plain-text 403 or
      // the recipient PIN page instead of the sign-in redirect.
      for (const path of ["/receipts/new", "/receipts/HR-000001/return"]) {
        const res = await runIp(ipRequest({ path, ip: "9.0.0.1" }));
        expect(res.headers.get("location"), path).toContain("/login");
      }
    });

    it("still treats a receipt and its PDF as public", async () => {
      for (const path of ["/receipts/HR-000001", "/receipts/HR-000001/pdf"]) {
        const res = await runIp(ipRequest({ path, ip: "9.0.0.2" }));
        expect(res.headers.get("location"), path).toBeNull();
      }
    });

    it("still meters the home page for anonymous callers, PIN gate or not", async () => {
      // `/` left the PIN gate, but it must not leave gate 0b with it: it is
      // still an anonymous, unauthenticated page and it fronts the search
      // action, so it stays inside the anti-scraping budget and the browser
      // check.
      const hit = () => runIp(ipRequest({ path: "/", ip: "6.0.0.5" }));
      for (let i = 0; i < API_POLICY.limit; i++) {
        expect((await hit()).status, `request ${i + 1}`).not.toBe(429);
      }
      expect((await hit()).status).toBe(429);
      expect(
        (await runIp(ipRequest({ path: "/", ip: "6.0.0.6", userAgent: "curl/8.4.0" }))).status,
      ).toBe(403);
    });

    it("leaves an authenticated technician's own routes alone", async () => {
      for (let i = 0; i < API_POLICY.limit + 20; i++) {
        const res = await runIp(ipRequest({ path: "/items", ip: "6.0.0.3", loggedIn: true }));
        expect(res.status).not.toBe(429);
      }
    });
  });

  describe("automation filter", () => {
    beforeEach(() => {
      vi.stubEnv("PUBLIC_ACCESS_PIN_ENABLED", "false");
    });

    it("refuses an anonymous request with NO User-Agent", async () => {
      // The strong signal: every real browser sends one, and a bulk scraper
      // often does not bother.
      const res = await runIp(ipRequest({ path: "/i/abc", ip: "8.0.0.1", userAgent: null }));
      expect(res.status).toBe(403);
    });

    it("refuses a blank User-Agent as well as a missing one", async () => {
      const res = await runIp(ipRequest({ path: "/i/abc", ip: "8.0.0.2", userAgent: "   " }));
      expect(res.status).toBe(403);
    });

    it("refuses the default agents of common automation tools", async () => {
      const agents = [
        "curl/8.4.0",
        "Wget/1.21.4",
        "python-requests/2.31.0",
        "Scrapy/2.11 (+https://scrapy.org)",
        "Go-http-client/2.0",
      ];
      for (const [i, ua] of agents.entries()) {
        const res = await runIp(ipRequest({ path: "/i/abc", ip: `8.1.0.${i}`, userAgent: ua }));
        expect(res.status, ua).toBe(403);
      }
    });

    it("lets ordinary browsers through, including mobile Safari", async () => {
      // The failure this app can least afford is refusing a real person: the
      // public surface is how a soldier reads their own hand receipt, usually
      // from a phone after scanning a QR code.
      const agents = [
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
        // Headless Chrome is deliberately allowed through: blocking it buys
        // nothing (one line of Playwright changes the string) and it broke this
        // repo's own e2e suite. Turnstile is the headless defence.
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15",
      ];
      for (const [i, ua] of agents.entries()) {
        const res = await runIp(ipRequest({ path: "/i/abc", ip: `8.2.0.${i}`, userAgent: ua }));
        expect(res.status, ua).not.toBe(403);
      }
    });

    it("does NOT filter a signed-in technician", async () => {
      // Scoped to anonymous callers for the same reason the rate limit is: a
      // technician may be driving a script, and that is their business.
      const res = await runIp(
        ipRequest({ path: "/i/abc", ip: "8.0.0.3", userAgent: null, loggedIn: true }),
      );
      expect(res.status).not.toBe(403);
    });

    it("does NOT filter the auth endpoint", async () => {
      // Auth.js callbacks and any future scripted client must not depend on a
      // UA string; the sign-in budget is the control there.
      const res = await runIp(
        ipRequest({
          path: "/api/auth/callback/credentials",
          ip: "8.0.0.4",
          method: "POST",
          userAgent: null,
        }),
      );
      expect(res.status).not.toBe(403);
    });

    it("can be turned off for local work", async () => {
      // Without a switch, `curl http://localhost:3000/i/<id>` against a dev
      // server is a 403 with no way to opt out, and anything scripted has to
      // spoof a browser. Same switch as the limiter.
      vi.stubEnv("RATE_LIMIT_DISABLED", "true");
      const res = await runIp(ipRequest({ path: "/i/abc", ip: "8.0.0.6", userAgent: null }));
      expect(res.status).not.toBe(403);
    });

    it("refuses before spending a rate-limit token", async () => {
      // Cheapest refusal first — a request with no User-Agent never needed a
      // bucket, and letting it spend one would let a header-less flood exhaust
      // the budget of everyone sharing that IP.
      const ip = "8.0.0.5";
      for (let i = 0; i < API_POLICY.limit + 20; i++) {
        expect((await runIp(ipRequest({ path: "/i/abc", ip, userAgent: null }))).status).toBe(403);
      }
      const browser = await runIp(ipRequest({ path: "/i/abc", ip }));
      expect(browser.status).not.toBe(429);
    });
  });
});

describe("proxy — config.matcher exclusion for the MDM import route", () => {
  // Regression guard for the matcher STRING itself, not the login-gate logic
  // exercised above. Without `api/items/import` in the negative lookahead, a
  // session-less machine POST hits the coarse login gate and is redirected to
  // /login — which a redirect-following client (PowerShell's
  // Invoke-RestMethod) turns into a 200 with login-page HTML, so a scheduled
  // import job logs success while importing nothing, silently, for however
  // long it takes someone to notice the fleet stopped changing.
  //
  // This is also the exact hazard the plan flagged: another branch rewrites
  // this file wholesale, and whichever branch merges second must re-apply the
  // exclusion by hand. A plain code review can miss that; this test cannot —
  // it fails the instant the exclusion is dropped or re-generalised, with no
  // need to exercise the rest of the proxy.
  //
  // Anchored full-string match, mirroring how Next compiles a matcher pattern
  // against a pathname.
  const matcher = new RegExp(`^${config.matcher[0]}$`);
  /** True when the given pathname is matched by config.matcher — i.e. the
   *  proxy DOES run on it. False means the path is excluded (skips the proxy
   *  entirely: no login gate, no PIN gate, no rate limit). */
  const runsProxy = (path: string) => matcher.test(path);

  it("excludes /api/items/import — the route authenticates itself, so the proxy must not intercept it", () => {
    expect(runsProxy("/api/items/import")).toBe(false);
  });

  it("does NOT exclude /api/items/importantthing, proving the exclusion is segment-anchored", () => {
    // Without the `(?:/|$)` anchor, a bare-prefix match on "api/items/import"
    // would also swallow this sibling path — skipping its login gate for a
    // route nobody meant to exempt.
    expect(runsProxy("/api/items/importantthing")).toBe(true);
  });

  it("does NOT exempt the whole api/items namespace", () => {
    // A future route under /api/items/* (e.g. a UI-only fetch endpoint) must
    // keep its login gate, PIN gate, rate limit, and session-cookie refresh —
    // only the one named import route authenticates itself by secret.
    expect(runsProxy("/api/items/something")).toBe(true);
  });
});

describe("proxy — scoped receipt link", () => {
  const HR = "HR-000123";
  const link = async (receiptNumber = HR) =>
    signReceiptLinkToken(receiptNumber, SECRET);
  const grant = async (receiptNumber = HR, secure = false) => ({
    [receiptGrantCookieName(secure)]: receiptGrantValue(
      receiptNumber,
      await signReceiptLinkToken(receiptNumber, SECRET),
    ),
  });

  it("admits a valid ?k= link, stripping the token and remembering the grant", async () => {
    const res = await run(request({ path: `/receipts/${HR}?k=${await link()}` }));
    const location = res.headers.get("location") ?? "";
    expect(location).toContain(`/receipts/${HR}`);
    expect(location).not.toContain("k=");
    expect(location).not.toContain("/unlock");
    expect(res.headers.get("set-cookie") ?? "").toContain(receiptGrantCookieName(false));
  });

  it("preserves other query parameters when it strips the token", async () => {
    const res = await run(request({ path: `/receipts/${HR}?utm=mail&k=${await link()}` }));
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("utm=mail");
    expect(location).not.toContain("k=");
  });

  it("sets the grant cookie with the Secure ATTRIBUTE in production", async () => {
    // Same prod-only blind spot as the unlock cookie: a __Secure- prefixed
    // cookie sent without the attribute is dropped by the browser outright, so
    // the grant would never stick and every recipient would still see /unlock.
    // Matched as an attribute (`; Secure`), never as a substring — the cookie is
    // NAMED __Secure-pub_receipt, so toContain("Secure") passes on the name.
    vi.stubEnv("NODE_ENV", "production");
    const res = await run(request({ path: `/receipts/${HR}?k=${await link()}` }));
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(receiptGrantCookieName(true));
    expect(setCookie).toContain("; Secure");
    expect(setCookie).toContain("HttpOnly");
  });

  it("admits the receipt page and its PDF on the grant cookie alone", async () => {
    expect((await run(request({ path: `/receipts/${HR}`, cookies: await grant() })))
      .headers.get("location")).toBeNull();
    expect((await run(request({ path: `/receipts/${HR}/pdf`, cookies: await grant() })))
      .headers.get("location")).toBeNull();
  });

  it("REFUSES another receipt on that grant", async () => {
    const res = await run(request({ path: "/receipts/HR-000456", cookies: await grant() }));
    expect(res.headers.get("location")).toContain("/unlock");
  });

  it("REFUSES an item page on that grant", async () => {
    // A receipt grant must never reach the device catalog.
    const res = await run(request({ path: "/i/abc", cookies: await grant() }));
    expect(res.headers.get("location")).toContain("/unlock");
  });

  it("refuses a token minted for a different receipt", async () => {
    const res = await run(request({ path: `/receipts/${HR}?k=${await link("HR-000456")}` }));
    expect(res.headers.get("location")).toContain("/unlock");
  });

  it("refuses a forged token and sets no cookie", async () => {
    const res = await run(request({ path: `/receipts/${HR}?k=not-a-signature` }));
    expect(res.headers.get("location")).toContain("/unlock");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("does not let a link token unlock the receipt BUILDER", async () => {
    // /receipts/new is staff-only and is deliberately outside the PIN gate; it
    // must keep falling through to the login redirect, not the unlock page.
    const res = await run(request({ path: `/receipts/new?k=${await link("new")}` }));
    expect(res.headers.get("location")).toContain("/login");
  });

  it("leaves a logged-in user alone", async () => {
    const req = request({ path: `/receipts/${HR}?k=${await link()}` });
    Object.defineProperty(req, "auth", { value: { user: { id: "u1" } }, configurable: true });
    const res = await run(req);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("leaves a PIN-unlocked visitor alone rather than narrowing them to one receipt", async () => {
    const res = await run(
      request({
        path: `/receipts/${HR}?k=${await link()}`,
        cookie: await signUnlockValue(Date.now() + UNLOCK_TTL_MS, SECRET),
      }),
    );
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

