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
    const cookieValue = req.cookies.get(unlockCookieName(secure))?.value;
    const unlockValid = await verifyUnlockValue(cookieValue, secret, Date.now());
    if (shouldAllowPublic({ flagEnabled, loggedIn, unlockValid })) {
      return NextResponse.next();
    }
    const url = new URL("/unlock", req.url);
    url.searchParams.set("next", sanitizeNext(pathname + search));
    return NextResponse.redirect(url);
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
