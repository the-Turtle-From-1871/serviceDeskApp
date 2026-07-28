import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// `auth()` wraps the handler and pulls in Prisma; stub it so the proxy's own
// logic can be exercised without a database. The wrapper's only contract here
// is "call my handler with a request carrying `.auth`".
vi.mock("@/auth", () => ({
  auth: (handler: (req: NextRequest & { auth: unknown }) => unknown) => handler,
}));

import { proxy } from "./proxy";
import {
  signUnlockValue,
  unlockCookieName,
  UNLOCK_TTL_MS,
  UNLOCK_CLOCK_SKEW_MS,
} from "@/lib/public-access-cookie";

const SECRET = "test-secret";

/** Build a request for the public PII surface, optionally carrying a cookie. */
const request = (opts: { path?: string; cookie?: string; secure?: boolean } = {}) => {
  const headers = new Headers();
  if (opts.cookie !== undefined) {
    headers.set("cookie", `${unlockCookieName(opts.secure ?? false)}=${opts.cookie}`);
  }
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
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("proxy — public PIN gate", () => {
  it("lets a validly unlocked visitor through without touching their cookie", async () => {
    const value = await signUnlockValue(Date.now() + UNLOCK_TTL_MS, SECRET);
    const res = await run(request({ cookie: value }));
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

  it("refuses everyone when AUTH_SECRET is missing, rather than admitting them", async () => {
    // Fail CLOSED: with a blank key the expected MAC is hmac("", exp), which an
    // attacker can compute offline.
    const value = await signUnlockValue(Date.now() + UNLOCK_TTL_MS, SECRET);
    vi.stubEnv("AUTH_SECRET", "");
    const res = await run(request({ cookie: value }));
    expect(res.headers.get("location")).toContain("/unlock");
  });
});
