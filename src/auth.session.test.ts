import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  SESSION_IDLE_TIMEOUT_SECONDS,
  SESSION_MAX_AGE_SECONDS,
} from "@/lib/session-freshness";

// `src/lib/session-freshness.test.ts` pins the POLICY. This file pins the
// WIRING — that the policy is actually consulted, that sign-in stamps the
// claims, and that the pre-existing password-revocation check still runs after
// it. A policy nothing calls is worth nothing, and the two have already drifted
// once in this codebase's history for the `pwdChangedAt` claim.
//
// `next-auth` is captured rather than executed: importing it under vitest fails
// on its own `next/server` import. Capturing the config object is a faithful
// substitute because that object IS the contract — it is exactly what Auth.js
// consumes at runtime.
type JwtArgs = {
  token: Record<string, unknown>;
  user?: { id: string; role: string } | null;
};
type Captured = {
  session?: { strategy?: string; maxAge?: number };
  callbacks?: {
    jwt: (args: JwtArgs) => Promise<Record<string, unknown> | null>;
    session: (args: { session: Record<string, unknown>; token: Record<string, unknown> }) => unknown;
  };
};

const captured = vi.hoisted(() => ({ config: undefined as Captured | undefined }));
const findUnique = vi.hoisted(() => vi.fn());

vi.mock("next-auth", () => ({
  default: (config: Captured) => {
    captured.config = config;
    return { handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() };
  },
}));
vi.mock("next-auth/providers/credentials", () => ({ default: (opts: unknown) => opts }));
vi.mock("@/lib/prisma", () => ({ default: { user: { findUnique } } }));
vi.mock("@/lib/password", () => ({ verifyPassword: vi.fn() }));

import "@/auth";

const config = () => {
  if (!captured.config) throw new Error("NextAuth was never configured");
  return captured.config;
};
const jwt = (args: JwtArgs) => config().callbacks!.jwt(args);

const NOW = Date.parse("2026-07-28T17:00:00Z");
const secondsAgo = (s: number) => NOW - s * 1000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  findUnique.mockReset();
  // Default: the account exists and its password has never been changed, so
  // the pre-existing revocation check is a no-op and each test isolates the
  // freshness behavior it is actually about.
  findUnique.mockResolvedValue({ passwordChangedAt: null });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("session configuration", () => {
  it("bounds the cookie by the same constant as the absolute claim", () => {
    expect(config().session?.strategy).toBe("jwt");
    // Reading the shared constant is the point: `maxAge` shorter than the
    // absolute bound would expire the cookie before the claim it carries, and
    // the session would end early for a reason nothing logs.
    expect(config().session?.maxAge).toBe(SESSION_MAX_AGE_SECONDS);
    expect(config().session?.maxAge).toBe(30 * 24 * 60 * 60);
  });
});

describe("sign-in", () => {
  it("stamps both freshness claims", async () => {
    const token = await jwt({ token: {}, user: { id: "u1", role: "ADMIN" } });
    expect(token).toMatchObject({ id: "u1", role: "ADMIN", authAt: NOW, lastActiveAt: NOW });
  });
});

describe("subsequent requests", () => {
  const live = () => ({ id: "u1", authAt: secondsAgo(3600), lastActiveAt: secondsAgo(60) });

  it("moves the idle clock forward on an active session", async () => {
    const before = live();
    const token = await jwt({ token: { ...before, iat: Math.floor(NOW / 1000) } });
    expect(token).not.toBeNull();
    expect(token!.lastActiveAt).toBe(NOW);
    // The absolute stamp must NOT move, or the absolute bound never arrives.
    expect(token!.authAt).toBe(before.authAt);
  });

  it("revokes a session that has run out its absolute window, even if active", async () => {
    const token = await jwt({
      token: { id: "u1", authAt: secondsAgo(SESSION_MAX_AGE_SECONDS), lastActiveAt: secondsAgo(1) },
    });
    expect(token).toBeNull();
  });

  it("revokes a session idle past the idle bound", async () => {
    const token = await jwt({
      token: {
        id: "u1",
        // Older than `lastActiveAt`, and well inside the absolute bound, so
        // idleness is the only thing that can revoke this.
        authAt: secondsAgo(8 * 24 * 60 * 60),
        lastActiveAt: secondsAgo(SESSION_IDLE_TIMEOUT_SECONDS),
      },
    });
    expect(token).toBeNull();
  });

  it("does not hit the database for a session it has already revoked", async () => {
    await jwt({
      token: { id: "u1", authAt: secondsAgo(SESSION_MAX_AGE_SECONDS), lastActiveAt: secondsAgo(1) },
    });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("backfills a token minted before these claims existed, from its own iat", async () => {
    // Not from `now`: seeding to `now` would let a pre-deploy cookie saved from
    // devtools be re-pasted indefinitely, minting a fresh session each time,
    // because writing a new cookie cannot invalidate the old string.
    const rolledSecondsAgo = 30;
    const token = await jwt({
      token: { id: "u1", pwdChangedAt: null, iat: Math.floor(NOW / 1000) - rolledSecondsAgo },
    });
    expect(token).not.toBeNull();
    expect(token!.authAt).toBe(NOW - rolledSecondsAgo * 1000);
    expect(token!.lastActiveAt).toBe(NOW);
  });

  it("REVOKES a stale pre-deploy cookie rather than backfilling it", async () => {
    // A 40-day-old snapshot — past the absolute bound, so it is dead the first
    // time it is presented rather than being handed a fresh window.
    const token = await jwt({
      token: {
        id: "u1",
        pwdChangedAt: null,
        iat: Math.floor(NOW / 1000) - 40 * 24 * 60 * 60,
      },
    });
    expect(token).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("still revokes on a password change, after the freshness check", async () => {
    // Regression guard: the freshness code was inserted ahead of this check, so
    // an early `return` in the wrong place would silently disable live session
    // revocation — a security control this app already relies on.
    findUnique.mockResolvedValue({ passwordChangedAt: new Date(NOW - 1_000) });
    const token = await jwt({
      token: { id: "u1", pwdChangedAt: NOW - 10_000, authAt: secondsAgo(600), lastActiveAt: secondsAgo(10) },
    });
    expect(token).toBeNull();
  });

  it("still revokes a deleted account", async () => {
    findUnique.mockResolvedValue(null);
    const token = await jwt({
      token: { id: "u1", pwdChangedAt: null, authAt: secondsAgo(600), lastActiveAt: secondsAgo(10) },
    });
    expect(token).toBeNull();
  });

  it("still fails OPEN on a transient database error, keeping the refreshed claims", async () => {
    findUnique.mockRejectedValue(new Error("connection lost"));
    const token = await jwt({
      token: { id: "u1", pwdChangedAt: null, authAt: secondsAgo(600), lastActiveAt: secondsAgo(10) },
    });
    expect(token).not.toBeNull();
    expect(token!.lastActiveAt).toBe(NOW);
  });
});
