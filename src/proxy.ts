import { auth } from "@/auth";
import { NextResponse, type NextRequest, type NextFetchEvent } from "next/server";
import {
  shouldAllowPublic,
  verifyUnlockValue,
  unlockCookieName,
  sanitizeNext,
} from "@/lib/public-access-cookie";
import {
  API_POLICY,
  AUTH_SPRAY_POLICY,
  clientIp,
  consumeRateLimit,
  rateLimitDisabled,
  rateLimitKey,
  type RateLimitVerdict,
} from "@/lib/rate-limit";

// This proxy carries THREE gates (Next 16 allows a single proxy export). Next 16
// `proxy` (renamed from `middleware`) runs on the Node.js runtime, so `@/auth`
// (which pulls in Prisma/pg) bundles fine.
//
//  0. Anti-abuse.
//       • `/api/auth/*` — rate limited OUTSIDE the `auth()` wrapper (see below).
//       • `/api/*` and the public PII surface, for callers with no session:
//         a User-Agent check, then 100/min (API_POLICY), the anti-scraping
//         limit.
//  1. Public PII surface (`/`, `/i/*`, `/receipts/*`): the shared 8-digit PIN
//     gate, active only when PUBLIC_ACCESS_PIN_ENABLED is on. A logged-in user
//     OR a valid unlock cookie passes; otherwise redirect to /unlock. This is
//     NOT an authz boundary — real authz stays per-route (requireUser/
//     requireAdmin).
//  2. Every other matched route (`/items`, `/admin/*`, `/account`, …): the
//     app's pre-existing coarse login gate — a session is required, else
//     redirect to /login.
//
// Interactive sign-in and password reset are NOT limited here: they are Server
// Actions, and a 429 to an action POST surfaces as an unhandled error boundary
// rather than a message the user can read. Those limits live inside the actions
// themselves (`src/app/actions/auth.ts`, `src/app/actions/unlock.ts`), which can
// return an ordinary form error. The credential endpoint that would otherwise
// be a second door to the same capability is closed outright below, so there is
// no second budget to keep in step with theirs — and nothing metered here may
// share their scope, or an unauthenticated caller could spend the desk's
// sign-in budget without ever touching a password.

/** 429 with the headers a well-behaved client needs to back off. */
function tooManyRequests(verdict: RateLimitVerdict) {
  return new NextResponse("Too many requests. Please try again later.\n", {
    status: 429,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "retry-after": String(verdict.retryAfterSeconds),
      "x-ratelimit-limit": String(verdict.limit),
      "x-ratelimit-remaining": String(verdict.remaining),
      "x-ratelimit-reset": String(Math.ceil(verdict.resetAt / 1000)),
      // A throttled response must never be cached and served to someone else.
      "cache-control": "no-store",
    },
  });
}

/** 403 for a caller that did not present itself as a browser. */
function forbiddenAutomation() {
  return new NextResponse("This page is for browsers.\n", {
    status: 403,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * Exact-segment match. `startsWith("/api/auth")` would also swallow a future
 * `/api/authors`, which would silently skip BOTH the login gate and the
 * limiters.
 */
function isApiAuthPath(pathname: string): boolean {
  return pathname === "/api/auth" || pathname.startsWith("/api/auth/");
}

/**
 * The genuinely public read surface: the home search, an item page, and a
 * receipt (or its PDF).
 *
 * `/receipts/` as a bare prefix was wrong: it also swallowed `/receipts/new`
 * (the staff hand-receipt builder) and `/receipts/<n>/return` (admin-only), so
 * an anonymous request to either met the browser check and the PIN gate instead
 * of the sign-in redirect — a colleague following a bookmarked builder link got
 * a plain-text 403 rather than `/login`. Authorization was never the issue
 * (`requireUser` runs in-page regardless); the routing was.
 */
const isPublicPiiPath = (pathname: string) =>
  pathname === "/" ||
  pathname.startsWith("/i/") ||
  /^\/receipts\/(?!new(?:\/|$))[^/]+(?:\/pdf)?$/.test(pathname);

// Automation that does not pretend to be a browser. Deliberately a SHORT list of
// default user-agent strings, not a heuristic: it costs a scraper one line to
// change, so it is defence in depth against the lazy majority and nothing more.
// Anything cleverer would start refusing real people, which is the failure this
// app can least afford — the public surface is how a soldier reads their own
// hand receipt.
//
// `HeadlessChrome` is deliberately NOT here, and must not be added back.
// Headless browsers are what Turnstile is for (§13) — a UA match buys nothing
// against one, because setting a normal UA is a single line of Playwright, while
// it DOES refuse real tooling: it broke this repo's own `tests/e2e` suite, and
// would break uptime monitors and synthetic checks the same way. A filter that
// only catches the honest is worse than none when it catches our own tests.
const AUTOMATION_AGENTS = [
  "curl/",
  "wget/",
  "python-requests",
  "python-urllib",
  "scrapy",
  "go-http-client",
  "java/",
  "okhttp",
  "libwww-perl",
  "httpclient",
];

/**
 * True for a request that is not plausibly a browser.
 *
 * A MISSING User-Agent is the strong signal — every real browser sends one, and
 * a bulk scraper often does not bother. The name list is the weak one.
 */
function looksAutomated(userAgent: string | null): boolean {
  const ua = userAgent?.trim().toLowerCase() ?? "";
  if (!ua) return true;
  return AUTOMATION_AGENTS.some((needle) => ua.includes(needle));
}

// Gates 1 and 2 need to know whether the caller is signed in, so they live
// inside the `auth()` wrapper. Gate 0's `/api/auth` half deliberately does not
// — see `proxy` below.
//
// The cast is because `auth(handler)` is typed for the Route Handler shape
// (`(req, ctx: AppRouteHandlerFnContext)`), which is what you get when the
// wrapped function is exported directly. Calling it ourselves from a plain
// `proxy` export is the same runtime contract — `handleAuth` passes `args[1]`
// straight through to the handler as the event — but the declared context type
// does not match `NextFetchEvent`.
const authGatedProxy = auth(async (req) => {
  const { pathname, search } = req.nextUrl;
  const loggedIn = !!req.auth;
  const isPublicPii = isPublicPiiPath(pathname);

  // Gate 0b — the anti-scraping limit, for ANONYMOUS callers only.
  //
  // Exempting signed-in staff is not a nicety. `/items` renders a page of rows
  // each linking to `/i/<id>`, and Next prefetches those links in production —
  // the proxy runs on prefetches too. One technician scrolling a page of
  // inventory would spend ~50 tokens, and the whole service desk shares one NAT
  // egress IP, so a few people browsing at once would 429 each other out of the
  // app. The limit exists for anonymous scraping of the public PII surface, and
  // that is exactly where it is applied.
  //
  // This is also why the check sits here rather than ahead of `auth()`: knowing
  // the caller is signed in requires the session read. It costs little for the
  // traffic being shed — an anonymous request carries no session cookie, so
  // Auth.js short-circuits before any JWT decode or database query.
  if (!loggedIn && (isPublicPii || pathname.startsWith("/api/"))) {
    // Cheapest refusal first: a request with no User-Agent never needed a
    // bucket. Scoped to anonymous callers on the public surface for the same
    // reason the limit is — a signed-in technician might be driving a script,
    // and that is their business.
    if (!rateLimitDisabled() && looksAutomated(req.headers.get("user-agent"))) {
      return forbiddenAutomation();
    }
    const verdict = await consumeRateLimit(
      API_POLICY,
      rateLimitKey(API_POLICY, clientIp(req.headers)),
    );
    if (!verdict.allowed) return tooManyRequests(verdict);
  }

  if (isPublicPii) {
    const flagEnabled = process.env.PUBLIC_ACCESS_PIN_ENABLED === "true";
    const secret = process.env.AUTH_SECRET ?? "";
    const secure = process.env.NODE_ENV === "production";
    // Only the async HMAC verify runs when it can actually change the outcome
    // (flag on AND not already logged in) — off/ logged-in skip the crypto.
    const cookieName = unlockCookieName(secure);
    const presented = req.cookies.get(cookieName)?.value;
    const check =
      flagEnabled && !loggedIn
        ? await verifyUnlockValue(presented, secret, Date.now())
        : { valid: false, retire: false };
    const unlockValid = check.valid;
    if (shouldAllowPublic({ flagEnabled, loggedIn, unlockValid })) {
      return NextResponse.next();
    }
    const url = new URL("/unlock", req.url);
    url.searchParams.set("next", sanitizeNext(pathname + search));
    const res = NextResponse.redirect(url);
    // Expire the cookie that was actually REFUSED. Without this a rejected
    // cookie — most often one issued under a longer TTL and retired by the
    // ceiling check — is resent on every request to the public surface until its
    // own expiry, which can be days after it stopped working.
    //
    // Two details this depends on, both of which silently no-op if dropped:
    //
    // 1. The attributes must be spelled out. `cookies.delete(name)` expands to
    //    `set({name, value:"", expires:0})` with NO Secure and NO Path, and a
    //    Set-Cookie whose name carries the `__Secure-` prefix without the Secure
    //    attribute is rejected outright by browsers — so in PRODUCTION, the only
    //    place the prefix is used, the deletion never happened. (Path is safe to
    //    pass but not load-bearing: Next's normalizeCookie already defaults it
    //    to "/", which matches how unlock.ts sets the cookie.)
    //
    // 2. Only delete on `retire` — a cookie whose signature verified as ours but
    //    which is expired or over the TTL ceiling. A bare "was a cookie sent?"
    //    guard is not enough: the population this feature targets is exactly the
    //    one holding a stale cookie, so a slow request from another tab carrying
    //    the old value would still land its expiry after the user unlocked in a
    //    second tab. Keying on `retire` stops a transient blank or mid-rotation
    //    AUTH_SECRET from destroying every genuine cookie in the wild — that
    //    refusal is not a retirement, and the outage stays self-healing once the
    //    config is fixed.
    //
    //    NOT fixed, because HTTP cannot express it: a slow request already
    //    carrying the STALE cookie can still land its expiry after the user
    //    unlocks in another tab, clearing the fresh cookie and sending them back
    //    to /unlock once. A deletion names a cookie, not a value, so there is no
    //    "delete only if it still equals X". The window is one request, only for
    //    someone holding a retired cookie, and the cost is re-entering the PIN;
    //    accepted rather than papered over. See docs/SECURITY.md, Known gaps.
    if (check.retire) {
      res.cookies.delete({ name: cookieName, path: "/", secure, httpOnly: true, sameSite: "lax" });
    }
    return res;
  }

  // Existing coarse login gate for all other matched routes.
  if (!loggedIn) {
    return NextResponse.redirect(new URL("/login", req.url));
  }
  return NextResponse.next();
}) as unknown as (req: NextRequest, event: NextFetchEvent) => Promise<NextResponse>;

export async function proxy(req: NextRequest, event: NextFetchEvent) {
  const { pathname } = req.nextUrl;

  // Gate 0a — `/api/auth/*`, handled BEFORE `auth()` and returning without
  // delegating to it. Two reasons, both load-bearing:
  //
  //  • Auth.js's own endpoint must never reach the login gate, or signing in
  //    would redirect to itself.
  //  • The `auth()` wrapper resolves the session before it calls its handler,
  //    so delegating would make every request to the auth endpoint pay a second
  //    session read on top of the one the route handler already does — a
  //    per-request database query, for the one path an unauthenticated attacker
  //    can hammer.
  if (isApiAuthPath(pathname)) {
    const ip = clientIp(req.headers);
    // GET/HEAD (csrf token, providers, session) is not an attempt at anything,
    // so it does not spend from the sign-in budget — but it is still metered,
    // under the general policy. Left unmetered it was the one route in the app
    // with no limit at all.
    if (req.method === "GET" || req.method === "HEAD") {
      const verdict = await consumeRateLimit(
        API_POLICY,
        rateLimitKey(API_POLICY, ip, "api-auth"),
      );
      if (!verdict.allowed) return tooManyRequests(verdict);
      return NextResponse.next();
    }

    // `POST /api/auth/callback/*` is CLOSED, not merely throttled.
    //
    // It is a fully working second front door to the credential check, and it
    // is a door this app does not use: `loginAction` calls `signIn()` in
    // process, which never round-trips through the HTTP endpoint. Leaving it
    // open meant every protection layered onto the Server Action — the
    // Turnstile challenge, the per-account composite bucket, and the global
    // botnet counter that only `loginAction` feeds — could be walked around by
    // POSTing here instead. A distributed attack driving this path would have
    // produced no velocity signal at all, which is precisely the attack the
    // detector exists for.
    //
    // Rate limiting it was not enough: a limit an attacker can spend twice (once
    // per surface) is not the limit the docs describe, and no per-IP number
    // helps against a botnet. Closing it removes the surface instead of trying
    // to re-implement three controls on it.
    if (pathname.startsWith("/api/auth/callback/")) {
      return new NextResponse("Not found.\n", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
    }

    // Any other mutation here (sign-out, and whatever Auth.js adds later) is
    // metered on its OWN bucket — scope `api-auth-write`, never `login`.
    //
    // Sharing the `login` scope with `loginAction` was a lockout waiting to
    // happen: `POST /api/auth/signout` needs no CSRF token, no body and no
    // session, so 60 of them from anywhere would fill the very bucket that
    // gates sign-in and refuse every technician behind that egress IP for
    // fifteen minutes, repeatably. That is the whole-desk lockout
    // `spendAuthBudget`'s narrow-bucket-first ordering exists to prevent,
    // reintroduced through a second door.
    //
    // The reason the scopes were shared is gone: it was to stop
    // `POST /api/auth/callback/*` doubling the sign-in budget, and that path is
    // now closed with a 404 above. There is no second door left to keep in step.
    const verdict = await consumeRateLimit(
      AUTH_SPRAY_POLICY,
      rateLimitKey(AUTH_SPRAY_POLICY, ip, "api-auth-write"),
    );
    if (!verdict.allowed) return tooManyRequests(verdict);
    return NextResponse.next();
  }

  return authGatedProxy(req, event);
}

export const config = {
  // Same negative-lookahead as before, with three changes: `receipts/`, `i/`,
  // and the bare-root `$` are REMOVED (so the proxy now runs on the public PII
  // routes to PIN-gate them), and `unlock` is ADDED (so the PIN page stays
  // reachable). `wasm/` etc. stay excluded — see the prior comment history.
  //
  // `api/auth` is no longer excluded: gate 0a meters it and returns before the
  // login gate can see it.
  //
  // `api/cron` stays excluded on purpose. It authenticates with a constant-time
  // CRON_SECRET compare and is called once a day by GitHub Actions; putting it
  // behind a shared per-IP bucket would let unrelated traffic from the same
  // egress starve the purge job.
  //
  // The exclusions are SEGMENT-anchored with `(?:/|$)`. Unanchored, they were
  // prefixes: `/api/cronjobs`, `/logins`, `/unlockables` or `/terms-of-service`
  // would all have matched an exclusion and skipped the proxy entirely — no
  // login gate, no PIN gate, no rate limit, no session-cookie refresh. That is
  // the same hazard `isApiAuthPath` was written to avoid, one screen up, and the
  // fix had been applied only in code. The last three keep their trailing-slash
  // prefix form on purpose: they are directories, not routes.
  matcher: [
    "/((?!(?:api/cron|login|forgot-password|reset-password|privacy|terms|unlock|favicon\\.ico)(?:/|$)|_next/static|_next/image|wasm/).*)",
  ],
};
