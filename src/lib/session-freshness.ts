// Session lifecycle policy: a 10-hour workday, with a 4-hour idle cut-off.
//
// Pure and dependency-free on purpose — `src/auth.ts` pulls in Prisma, so the
// decision itself lives here where it can be tested directly, exactly like
// `public-access-cookie.ts` is split out of the PIN gate.
//
// ── Why claims and not just `session.maxAge` ─────────────────────────────────
// Auth.js JWT sessions ROLL. Every `auth()` call runs the session action, which
// re-signs the token with `exp = now + session.maxAge` and a fresh `iat` (see
// `@auth/core/lib/actions/session.js` and `@auth/core/jwt.js` → `encode`). So
// `maxAge: 10h` alone is a 10-hour IDLE timeout, not an absolute one: a
// technician who keeps a tab open is never signed out. The absolute bound has
// to be an issued-at claim the refresh cannot move, which is `authAt`.
//
// `lastActiveAt` is the other half: it moves on every request, so it measures
// idleness — the thing `maxAge` would have measured, but at 4 hours instead of
// 10 and without competing with the absolute bound.

/** Absolute session lifetime. A sign-in is good for one 10-hour workday. */
export const SESSION_MAX_AGE_SECONDS = 10 * 60 * 60;

/** Re-authenticate after this long with no requests. */
export const SESSION_IDLE_TIMEOUT_SECONDS = 4 * 60 * 60;

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
  // equivalent and is not: it hands a fresh 10 hours to *whatever presents an
  // un-seeded token*, and seeding writes a new cookie without invalidating the
  // old string — Auth.js JWTs are stateless, there is no revocation list. So a
  // pre-deploy cookie saved from devtools could be re-pasted over and over,
  // each time minting another full session, until its own 30-day `exp` ran out.
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

  // A token stamped in the future is clock skew between instances, not a
  // 10-hour-old session. Treating `now - authAt < 0` as "expired" would be
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
