import { describe, expect, it } from "vitest";
import {
  SESSION_IDLE_TIMEOUT_SECONDS,
  SESSION_MAX_AGE_SECONDS,
  sessionFreshness,
} from "./session-freshness";

const NOW = Date.parse("2026-07-28T17:00:00Z");
const secondsAgo = (s: number) => NOW - s * 1000;

describe("the policy constants", () => {
  it("is a 10-hour workday with a 4-hour idle cut-off", () => {
    // Literals as an independent oracle: without them every assertion below
    // derives from the same constant it is meant to pin, and changing the
    // constant to 10 minutes would keep the suite green.
    expect(SESSION_MAX_AGE_SECONDS).toBe(10 * 60 * 60);
    expect(SESSION_IDLE_TIMEOUT_SECONDS).toBe(4 * 60 * 60);
    expect(SESSION_IDLE_TIMEOUT_SECONDS).toBeLessThan(SESSION_MAX_AGE_SECONDS);
  });
});

describe("sessionFreshness", () => {
  it("keeps an active session alive without moving its absolute stamp", () => {
    const authAt = secondsAgo(3600);
    expect(sessionFreshness({ authAt, lastActiveAt: secondsAgo(30) }, NOW)).toEqual({
      action: "keep",
      authAt,
    });
  });

  it("revokes at the 10-hour absolute bound even while the user is active", () => {
    // The point of the absolute bound: `lastActiveAt` is one second old, so an
    // idle-only policy (which is all `session.maxAge` gives you, because
    // Auth.js re-signs the token on every request) would keep this alive
    // forever.
    expect(
      sessionFreshness(
        { authAt: secondsAgo(SESSION_MAX_AGE_SECONDS), lastActiveAt: secondsAgo(1) },
        NOW,
      ),
    ).toEqual({ action: "revoke", reason: "absolute" });
  });

  it("is still alive one second before the absolute bound", () => {
    const authAt = secondsAgo(SESSION_MAX_AGE_SECONDS - 1);
    expect(sessionFreshness({ authAt, lastActiveAt: secondsAgo(1) }, NOW)).toEqual({
      action: "keep",
      authAt,
    });
  });

  it("revokes after 4 hours of inactivity, well inside the absolute window", () => {
    expect(
      sessionFreshness(
        { authAt: secondsAgo(5 * 60 * 60), lastActiveAt: secondsAgo(SESSION_IDLE_TIMEOUT_SECONDS) },
        NOW,
      ),
    ).toEqual({ action: "revoke", reason: "idle" });
  });

  it("is still alive one second before the idle bound", () => {
    const authAt = secondsAgo(5 * 60 * 60);
    expect(
      sessionFreshness(
        { authAt, lastActiveAt: secondsAgo(SESSION_IDLE_TIMEOUT_SECONDS - 1) },
        NOW,
      ),
    ).toEqual({ action: "keep", authAt });
  });

  it("reports the absolute bound when BOTH have lapsed", () => {
    // Not cosmetic: the reason is what a log or a future "you were signed out
    // because…" message would say, and "idle" would be a lie for a session
    // that simply ran out its workday.
    expect(
      sessionFreshness({ authAt: secondsAgo(30 * 60 * 60), lastActiveAt: secondsAgo(20 * 60 * 60) }, NOW),
    ).toEqual({ action: "revoke", reason: "absolute" });
  });

  it("does not treat clock skew between instances as an expiry", () => {
    // A token stamped slightly in the future must not read as 10 hours old.
    // Getting this wrong fails in the one direction that logs people out.
    const authAt = NOW + 5_000;
    expect(sessionFreshness({ authAt, lastActiveAt: NOW + 5_000 }, NOW)).toEqual({
      action: "keep",
      authAt,
    });
  });
});

describe("backfilling a token minted before these claims existed", () => {
  // The rollout case. Treating a missing claim as infinitely old would sign
  // every logged-in technician out the moment this deploys.
  it("keeps a live pre-deploy session alive, dated from its last roll", () => {
    // `iat` is re-stamped on every request, so a session in active use has an
    // `iat` of moments ago.
    const justRolled = secondsAgo(2);
    expect(sessionFreshness({ issuedAtMs: justRolled }, NOW)).toEqual({
      action: "keep",
      authAt: justRolled,
    });
  });

  it("REVOKES a stale pre-deploy cookie instead of minting it a fresh workday", () => {
    // The replay this closes. Backfilling from `now` looks equivalent and is
    // not: seeding writes a NEW cookie but cannot invalidate the old string —
    // Auth.js JWTs are stateless, there is no revocation list — so a cookie
    // saved from devtools before the deploy could be re-pasted over and over,
    // each time minting another full 10-hour session, until its own 30-day
    // expiry ran out. Dating the backfill from the token's own `iat` bounds
    // that to the same 10 hours as everything else.
    expect(sessionFreshness({ issuedAtMs: secondsAgo(30 * 24 * 60 * 60) }, NOW)).toEqual({
      action: "revoke",
      reason: "absolute",
    });
  });

  it("revokes a pre-deploy cookie last used more than 4 hours ago — as IDLE", () => {
    // Five hours is inside the 10-hour absolute bound but outside the 4-hour
    // idle one, and the reason must say so: a backfilled token is treated by
    // exactly the same two rules as any other, not by a special case.
    expect(sessionFreshness({ issuedAtMs: secondsAgo(5 * 60 * 60) }, NOW)).toEqual({
      action: "revoke",
      reason: "idle",
    });
  });

  it("backfills each claim independently, so a real authAt is never restarted", () => {
    // A token carrying a genuine `authAt` but no `lastActiveAt` must keep its
    // absolute clock. Backfilling the pair together would silently hand it a
    // fresh 10 hours.
    const authAt = secondsAgo(SESSION_MAX_AGE_SECONDS + 60);
    expect(sessionFreshness({ authAt, issuedAtMs: NOW }, NOW)).toEqual({
      action: "revoke",
      reason: "absolute",
    });
  });

  it("falls back to now only when the token carries no iat at all", () => {
    // Belt and braces: `iat` is always present on an Auth.js token, but a
    // missing one must not throw or revoke everybody.
    expect(sessionFreshness({}, NOW)).toEqual({ action: "keep", authAt: NOW });
    expect(sessionFreshness({ authAt: null, lastActiveAt: null }, NOW)).toEqual({
      action: "keep",
      authAt: NOW,
    });
  });
});
