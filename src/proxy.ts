import { auth } from "@/auth";
import { NextResponse } from "next/server";
import {
  shouldAllowPublic,
  verifyUnlockValue,
  unlockCookieName,
  sanitizeNext,
} from "@/lib/public-access-cookie";

// This proxy carries TWO gates in one file (Next 16 allows a single proxy
// export). Next 16 `proxy` (renamed from `middleware`) runs on the Node.js
// runtime, so `@/auth` (which pulls in Prisma/pg) bundles fine.
//
//  1. Public PII surface (`/`, `/i/*`, `/receipts/*`): the shared 8-digit PIN
//     gate, active only when PUBLIC_ACCESS_PIN_ENABLED is on. A logged-in user
//     OR a valid unlock cookie passes; otherwise redirect to /unlock. This is
//     NOT an authz boundary — real authz stays per-route (requireUser/
//     requireAdmin).
//  2. Every other matched route (`/items`, `/admin/*`, `/account`, …): the
//     app's pre-existing coarse login gate — a session is required, else
//     redirect to /login. `auth()` populates `req.auth` (null if the session
//     is absent or was revoked), preserving the prior behavior.
//
// The matcher excludes `/unlock` (else a logged-out visitor would be bounced
// off the PIN page itself) plus the other public/asset paths. It now RUNS on
// `/`, `/i/*`, `/receipts/*` (previously excluded) so the PIN gate can see them.
export const proxy = auth(async (req) => {
  const { pathname, search } = req.nextUrl;
  const loggedIn = !!req.auth;

  const isPublicPii =
    pathname === "/" ||
    pathname.startsWith("/i/") ||
    pathname.startsWith("/receipts/");

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
});

export const config = {
  // Same negative-lookahead as before, with three changes: `receipts/`, `i/`,
  // and the bare-root `$` are REMOVED (so the proxy now runs on the public PII
  // routes to PIN-gate them), and `unlock` is ADDED (so the PIN page stays
  // reachable). `wasm/` etc. stay excluded — see the prior comment history.
  matcher: ["/((?!api/auth|api/cron|login|forgot-password|reset-password|privacy|terms|unlock|_next/static|_next/image|favicon.ico|wasm/).*)"],
};
