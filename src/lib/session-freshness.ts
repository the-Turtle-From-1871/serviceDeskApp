// Session lifecycle policy: 30 days absolute, with a 7-day idle cut-off.
//
// Pure and dependency-free on purpose — `src/auth.ts` pulls in Prisma, so the
// decision itself lives here where it can be tested directly, exactly like
// `public-access-cookie.ts` is split out of the PIN gate.
//
// ── Why claims and not just `session.maxAge` ─────────────────────────────────
// Auth.js JWT sessions ROLL. Every `auth()` call runs the session action, which
// re-signs the token with `exp = now + session.maxAge` and a fresh `iat` (see
// `@auth/core/lib/actions/session.js` and `@auth/core/jwt.js` → `encode`). So
// `maxAge` alone is an IDLE timeout, not an absolute one: a technician who
// keeps a tab open is never signed out. The absolute bound has to be an
// issued-at claim the refresh cannot move, which is `authAt`.
//
// `lastActiveAt` is the other half: it moves on every request, so it measures
// idleness — the thing `maxAge` would have measured, but at 7 days and without
// competing with the absolute bound.
//
// ── Why these numbers (was 10h absolute / 4h idle until 2026-08-06) ──────────
// The workday framing did not survive contact with how the app is actually
// used. It is installed to the iOS home screen, and a home-screen web app has
// its own cookie jar — so every technician who opened the icon after lunch, or
// on any morning, was met by the login form. Re-authenticating twice a day on
// a personal device trains people to keep the password somewhere convenient,
// which costs more than the window it was buying.
//
// The window is NOT the only revocation lever, which is what makes a long one
// affordable here: `requireUser`/`requireAdmin` re-read `role` + `isActive`
// from the DB on every request, and the `jwt` callback re-checks
// `passwordChangedAt` on every call. Deactivating an account or resetting a
// password kills a live session immediately — a 29-day-old one included. What
// lengthened is convenience, not time-to-revoke.
//
// The accepted cost: a session token captured off a device stays replayable
// for up to 7 days of idleness rather than 4 hours. See docs/SECURITY.md,
// Known gaps.

/** Absolute session lifetime. A sign-in is good for 30 days, then re-auth. */
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/** Re-authenticate after this long with no requests. */
export const SESSION_IDLE_TIMEOUT_SECONDS = 7 * 24 * 60 * 60;

export type SessionClaims = {
  /** Epoch ms the session was established. Never moved after sign-in. */
  authAt?: number | null;
  /** Epoch ms of the most recent request on this session. */
  lastActiveAt?: number | null;
  /**
   * The JWT's own `iat`, in epoch ms — what a missing claim is backfilled
   * from. See `backfill` below for why this must not be `now`.
   */
  issuedAtMs?: number | null;
};

export type FreshnessVerdict =
  /** Revoke: return null from the jwt callback, which clears the cookies. */
  | { action: "revoke"; reason: "absolute" | "idle" }
  /**
   * Fresh. `authAt` is the value to write back — unchanged for a normal
   * request, backfilled for a token minted before these claims existed.
   */
  | { action: "keep"; authAt: number };

/**
 * Decide what to do with a token's freshness claims.
 *
 * @param claims the `authAt` / `lastActiveAt` / `iat` carried by the JWT
 * @param now    epoch ms
 */
export function sessionFreshness(claims: SessionClaims, now: number): FreshnessVerdict {
  // Backfill a token minted before these claims existed, so the deploy that
  // adds them does not sign every logged-in technician out at once.
  //
  // From the token's own `iat`, NOT from `now`. Seeding to `now` looks
  // equivalent and is not: it hands a fresh absolute window to *whatever
  // presents an un-seeded token*, and seeding writes a new cookie without
  // invalidating the old string — Auth.js JWTs are stateless, there is no
  // revocation list. So a pre-deploy cookie saved from devtools could be
  // re-pasted over and over, each time minting another full session, until its
  // own `exp` ran out.
  // `iat` is re-stamped on every roll, so a live session backfills to ~now
  // (nobody is signed out) while a stale snapshot backfills to when it was last
  // used and fails these bounds immediately.
  //
  // Each claim is backfilled independently: a token carrying a real `authAt`
  // must keep it, or a half-present claim set would silently restart the
  // absolute clock.
  const fallback = typeof claims.issuedAtMs === "number" ? claims.issuedAtMs : now;
  const authAt = typeof claims.authAt === "number" ? claims.authAt : fallback;
  const lastActiveAt =
    typeof claims.lastActiveAt === "number" ? claims.lastActiveAt : fallback;

  // A token stamped in the future is clock skew between instances, not an
  // expired session. Treating `now - authAt < 0` as "expired" would be
  // wrong in the one direction that logs people out, so it falls through to
  // the fresh path.
  if (now - authAt >= SESSION_MAX_AGE_SECONDS * 1000) {
    return { action: "revoke", reason: "absolute" };
  }
  if (now - lastActiveAt >= SESSION_IDLE_TIMEOUT_SECONDS * 1000) {
    return { action: "revoke", reason: "idle" };
  }
  return { action: "keep", authAt };
}
