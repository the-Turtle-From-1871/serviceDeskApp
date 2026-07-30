import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TURNSTILE_FIELD,
  turnstileConfigured,
  turnstileSiteKey,
  turnstileWidgetSiteKey,
  verifyTurnstile,
} from "./turnstile";

const SITE_KEY = "1x00000000000000000000AA";
const SECRET_KEY = "1x0000000000000000000000000000000AA";

const fetchMock = vi.fn();

function configure() {
  vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", SITE_KEY);
  vi.stubEnv("TURNSTILE_SECRET_KEY", SECRET_KEY);
}

function siteverifyBody(): URLSearchParams {
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return init.body as URLSearchParams;
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("configuration gate", () => {
  it("is off with no keys, and never calls Cloudflare", async () => {
    const res = await verifyTurnstile("some-token");
    expect(res).toEqual({ ok: true, status: "skipped" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(turnstileConfigured()).toBe(false);
    expect(turnstileSiteKey()).toBeNull();
  });

  it("needs BOTH halves — a site key alone renders a widget nobody checks", async () => {
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", SITE_KEY);
    expect(turnstileConfigured()).toBe(false);
    expect(await verifyTurnstile("t")).toEqual({ ok: true, status: "skipped" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("needs BOTH halves — a secret alone would refuse every sign-in", async () => {
    // No site key means no form can ever produce a token, so "enabled" here
    // would be a total outage of login rather than a stricter check.
    vi.stubEnv("TURNSTILE_SECRET_KEY", SECRET_KEY);
    expect(turnstileConfigured()).toBe(false);
    expect(await verifyTurnstile(null)).toEqual({ ok: true, status: "skipped" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is on with both", () => {
    configure();
    expect(turnstileConfigured()).toBe(true);
    expect(turnstileSiteKey()).toBe(SITE_KEY);
    expect(turnstileWidgetSiteKey()).toBe(SITE_KEY);
  });

  it("gives a page NO site key when the secret is missing", () => {
    // The half-configured deploy is a real state — someone sets the public half
    // first. Rendering on the site key alone produces the exact security
    // theatre this gate exists to prevent: a live widget that challenges
    // visitors and is then never verified, because verification skips without a
    // secret. `turnstileSiteKey()` still returns it; pages must not use that.
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", SITE_KEY);
    expect(turnstileSiteKey()).toBe(SITE_KEY);
    expect(turnstileWidgetSiteKey()).toBeNull();
  });
});

describe("verifyTurnstile when configured", () => {
  beforeEach(configure);

  const ok = (body: Record<string, unknown>) =>
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => body });

  it("accepts a token Cloudflare confirms", async () => {
    ok({ success: true });
    expect(await verifyTurnstile("good-token")).toEqual({ ok: true, status: "verified" });
  });

  it("REFUSES a token Cloudflare rejects, and keeps the codes for the log", async () => {
    ok({ success: false, "error-codes": ["timeout-or-duplicate"] });
    expect(await verifyTurnstile("spent-token")).toEqual({
      ok: false,
      status: "rejected",
      codes: ["timeout-or-duplicate"],
    });
  });

  it("refuses a blank or absent token without asking Cloudflare", async () => {
    for (const token of [null, undefined, "", "   "]) {
      expect(await verifyTurnstile(token)).toEqual({ ok: false, status: "missing" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an oversized token WITHOUT asking Cloudflare", async () => {
    // Otherwise the submitter chooses how many bytes we upload: a few hundred KB
    // reliably earns a 413 or blows the 5s timeout, both of which land in the
    // "unreachable" branch — which ALLOWS the submission. That turns fail-open
    // from an outage accommodation into a bypass anyone can trigger on demand.
    expect(await verifyTurnstile("x".repeat(200_000))).toEqual({ ok: false, status: "missing" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still accepts a token at a realistic length", async () => {
    ok({ success: true });
    expect(await verifyTurnstile("x".repeat(1024))).toEqual({ ok: true, status: "verified" });
  });

  it("posts the secret and the token form-encoded, uncached", async () => {
    ok({ success: true });
    await verifyTurnstile("good-token");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    expect(init.method).toBe("POST");
    // A cached "success" would make one solved challenge reusable forever.
    expect(init.cache).toBe("no-store");
    expect(siteverifyBody().get("secret")).toBe(SECRET_KEY);
    expect(siteverifyBody().get("response")).toBe("good-token");
  });

  it("sends remoteip only when it parses as an address", async () => {
    ok({ success: true });
    await verifyTurnstile("t", "203.0.113.9");
    expect(siteverifyBody().get("remoteip")).toBe("203.0.113.9");

    fetchMock.mockClear();
    ok({ success: true });
    // `clientIp()` can yield null, and a junk value earns an
    // `invalid-input-remoteip` rejection — which would refuse a GOOD token.
    await verifyTurnstile("t", "not-an-ip");
    expect(siteverifyBody().has("remoteip")).toBe(false);

    fetchMock.mockClear();
    ok({ success: true });
    await verifyTurnstile("t", null);
    expect(siteverifyBody().has("remoteip")).toBe(false);
  });

  it("trims the token rather than sending surrounding whitespace", async () => {
    ok({ success: true });
    await verifyTurnstile("  good-token  ");
    expect(siteverifyBody().get("response")).toBe("good-token");
  });
});

describe("verifyTurnstile failure posture", () => {
  beforeEach(configure);

  it("ALLOWS the submission when Cloudflare is unreachable", async () => {
    // Deliberate: a third-party outage must not lock the service desk out of
    // its own property book. The password check and rate limiter still apply.
    fetchMock.mockRejectedValue(new Error("ETIMEDOUT"));
    expect(await verifyTurnstile("t")).toEqual({ ok: true, status: "unreachable" });
    expect(console.error).toHaveBeenCalled();
  });

  it("ALLOWS the submission on a 5xx from siteverify", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502, json: async () => ({}) });
    expect(await verifyTurnstile("t")).toEqual({ ok: true, status: "unreachable" });
  });

  it("ALLOWS the submission when a non-JSON body comes back", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    });
    expect(await verifyTurnstile("t")).toEqual({ ok: true, status: "unreachable" });
  });

  it("ALLOWS the submission when the failure is ours or Cloudflare's, not the visitor's", async () => {
    // `*-input-secret` is our misconfiguration; `internal-error` is Cloudflare
    // saying "retry". Blocking every sign-in on either is a self-inflicted
    // outage, and it is the same call as an unreachable Cloudflare.
    for (const code of ["invalid-input-secret", "missing-input-secret", "internal-error"]) {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ success: false, "error-codes": [code] }),
      });
      expect(await verifyTurnstile("t")).toEqual({ ok: true, status: "unreachable" });
    }
  });

  it("still REFUSES a bad token when the response omits error-codes", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: false }) });
    expect(await verifyTurnstile("t")).toEqual({ ok: false, status: "rejected", codes: [] });
  });

  it("treats anything other than an explicit `success: true` as a failure", async () => {
    // Guards against a truthiness bug: a body of `{ success: "false" }` or a
    // missing field must not read as a pass.
    for (const body of [{}, { success: "true" }, { success: 1 }, { success: null }]) {
      fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => body });
      const res = await verifyTurnstile("t");
      expect(res.ok, JSON.stringify(body)).toBe(false);
    }
  });
});

describe("TURNSTILE_FIELD", () => {
  it("is the field name Cloudflare's widget actually injects", () => {
    // Hard-coded on purpose: this string is a contract with Cloudflare's script,
    // and a rename would silently make every submission look tokenless.
    expect(TURNSTILE_FIELD).toBe("cf-turnstile-response");
  });
});
