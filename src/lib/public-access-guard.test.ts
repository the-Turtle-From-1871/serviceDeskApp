import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const session = vi.fn<() => Promise<unknown>>();
let cookieJar: Record<string, string> = {};

vi.mock("@/lib/session", () => ({ getSession: () => session() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name in cookieJar ? { name, value: cookieJar[name] } : undefined),
  }),
}));

import { publicAccessAllowed } from "./public-access-guard";
import {
  signUnlockValue,
  unlockCookieName,
  UNLOCK_TTL_MS,
  UNLOCK_CLOCK_SKEW_MS,
} from "@/lib/public-access-cookie";

const SECRET = "test-secret";

beforeEach(() => {
  cookieJar = {};
  // Call history, not just the implementation: the "does not resolve the
  // session" test asserts on it, and `restoreAllMocks` does not clear a plain
  // `vi.fn()`.
  vi.clearAllMocks();
  session.mockResolvedValue(null);
  vi.stubEnv("PUBLIC_ACCESS_PIN_ENABLED", "true");
  vi.stubEnv("AUTH_SECRET", SECRET);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Put a validly-signed unlock cookie in the jar, as `unlockAction` would. */
async function unlock(secure = false, expMs = Date.now() + UNLOCK_TTL_MS) {
  cookieJar[unlockCookieName(secure)] = await signUnlockValue(expMs, SECRET);
}

// This is the check that replaced the proxy's cover for `liveSearchAction` once
// `/` had to become publicly readable. Its failure mode is silent — returning
// `true` too readily hands the whole item and receipt catalog to anyone who can
// POST, and nothing in the UI would look different.
describe("publicAccessAllowed", () => {
  it("refuses an anonymous caller with no unlock cookie", async () => {
    expect(await publicAccessAllowed()).toBe(false);
  });

  it("admits an anonymous caller holding a valid unlock cookie", async () => {
    await unlock();
    expect(await publicAccessAllowed()).toBe(true);
  });

  it("reads the __Secure- cookie in production", async () => {
    // Prod is the only environment that uses the prefix, so a read-path
    // regression here is invisible locally and locks out every unlocked
    // visitor — the same prod-only blind spot the proxy already shipped once.
    vi.stubEnv("NODE_ENV", "production");
    await unlock(true);
    expect(await publicAccessAllowed()).toBe(true);
  });

  it("refuses an expired cookie", async () => {
    await unlock(false, Date.now() - 1000);
    expect(await publicAccessAllowed()).toBe(false);
  });

  it("refuses a cookie claiming more life than the current TTL allows", async () => {
    await unlock(false, Date.now() + UNLOCK_TTL_MS + UNLOCK_CLOCK_SKEW_MS + 60_000);
    expect(await publicAccessAllowed()).toBe(false);
  });

  it("refuses a forged cookie", async () => {
    cookieJar[unlockCookieName(false)] = `${Date.now() + UNLOCK_TTL_MS}.not-a-real-signature`;
    expect(await publicAccessAllowed()).toBe(false);
  });

  it("fails CLOSED when AUTH_SECRET is missing", async () => {
    await unlock();
    vi.stubEnv("AUTH_SECRET", "");
    expect(await publicAccessAllowed()).toBe(false);
  });

  it("admits a signed-in user with no unlock cookie", async () => {
    session.mockResolvedValue({ user: { id: "u1" } });
    expect(await publicAccessAllowed()).toBe(true);
  });

  it("admits everyone when the gate is switched off", async () => {
    vi.stubEnv("PUBLIC_ACCESS_PIN_ENABLED", "false");
    expect(await publicAccessAllowed()).toBe(true);
  });

  it("does not resolve the session when the gate is off", async () => {
    // The search action calls this per keystroke. With the flag off the answer
    // cannot depend on the session, so decoding one is pure cost on the app's
    // hottest anonymous path.
    vi.stubEnv("PUBLIC_ACCESS_PIN_ENABLED", "false");
    await publicAccessAllowed();
    expect(session).not.toHaveBeenCalled();
  });
});
