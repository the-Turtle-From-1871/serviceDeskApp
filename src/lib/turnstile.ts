// Cloudflare Turnstile — the CAPTCHA-alternative in front of the two
// unauthenticated forms that do work for an anonymous caller: sign-in and
// "forgot password".
//
// Import-safe from a Server Action; the only I/O is one `fetch` to Cloudflare.
// It is NOT marked `server-only` because the site key half is public by design
// and read by a client component — but `TURNSTILE_SECRET_KEY` is only ever read
// inside `verifyTurnstile`, which runs on the server. Never inline the secret
// into a component.
//
// ── Configuration gate ───────────────────────────────────────────────────────
// Both keys must be set for the check to exist at all. With either missing the
// widget is not rendered and verification is skipped, so local dev, CI, the
// tests and a deploy that has not been given keys all keep working. That is a
// deliberate config gate, not a bypass: `turnstileConfigured()` reports it and
// docs/SECURITY.md records the deploy step.
//
// ── Failure posture ──────────────────────────────────────────────────────────
// A token Cloudflare REFUSES blocks the submission — that is the whole feature.
// A failure to REACH Cloudflare (timeout, 5xx, DNS) does not: it is logged and
// the submission proceeds. Same reasoning as the rate limiter's fail-open, and
// the same reason it is written down: an outage at a third party must not be
// able to lock the service desk out of its own property book. The password
// check, the rate limiter and the reset-token check all still apply.

/** The hidden field Turnstile injects into the enclosing `<form>`. */
export const TURNSTILE_FIELD = "cf-turnstile-response";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

// Cloudflare is in the request path of a login. Five seconds is long enough for
// a healthy round trip and short enough that an outage costs a pause, not a
// hang.
const VERIFY_TIMEOUT_MS = 5_000;

/** Generously above a real token (~1 KB), well below anything worth uploading. */
const MAX_TOKEN_LENGTH = 2048;

/**
 * `error-codes` that mean the failure is OURS or Cloudflare's, not the
 * visitor's — the `-input-secret` pair is a misconfigured deploy, and
 * `internal-error` is Cloudflare telling us to retry. Blocking every sign-in on
 * either would be a self-inflicted outage, so they take the same allow path as
 * an unreachable Cloudflare.
 */
const NOT_THE_VISITORS_FAULT = ["invalid-input-secret", "missing-input-secret", "internal-error"];

/**
 * Public site key. `NEXT_PUBLIC_` because the client component that renders the
 * widget needs it — site keys are not secret.
 *
 * Raw, and NOT what a page should call — use `turnstileWidgetSiteKey`.
 */
export function turnstileSiteKey(): string | null {
  return process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || null;
}

/**
 * The site key a page should render a widget for — null unless the check is
 * fully configured.
 *
 * The distinction is the whole point of the config gate. Rendering on the site
 * key ALONE produces the security theatre this module says it prevents: a live
 * widget that challenges visitors, injects a token, and is then never verified,
 * because `verifyTurnstile` skips without a secret. That is a real deploy state
 * (someone sets the public half first), and it looks protected from the outside.
 */
export function turnstileWidgetSiteKey(): string | null {
  return turnstileConfigured() ? turnstileSiteKey() : null;
}

function turnstileSecretKey(): string | null {
  return process.env.TURNSTILE_SECRET_KEY || null;
}

/**
 * True when BOTH halves are present. Deliberately requires both: a site key
 * without a secret renders a widget nobody checks (security theatre), and a
 * secret without a site key rejects every submission because no form can ever
 * produce a token (a total outage of sign-in).
 */
export function turnstileConfigured(): boolean {
  return turnstileSiteKey() !== null && turnstileSecretKey() !== null;
}

export type TurnstileOutcome =
  /** No keys configured — the check does not exist on this deployment. */
  | { ok: true; status: "skipped" }
  | { ok: true; status: "verified" }
  /** Cloudflare was unreachable; allowed on purpose. See the header comment. */
  | { ok: true; status: "unreachable" }
  /** The form arrived with no token at all — a bot, or JS disabled. */
  | { ok: false; status: "missing" }
  /** Cloudflare said no. `codes` is its `error-codes` array, for the log. */
  | { ok: false; status: "rejected"; codes: string[] };

/** Rough shape check so a bogus `remoteip` cannot fail an otherwise good token. */
function looksLikeIp(value: string | null): value is string {
  if (!value) return false;
  return /^[0-9.]+$/.test(value) || /^[0-9a-fA-F:]+$/.test(value);
}

/**
 * Verify a widget token against Cloudflare.
 *
 * @param token    the `cf-turnstile-response` form field
 * @param remoteIp the caller's IP, when one could be determined; ignored unless
 *                 it parses, because Cloudflare rejects a malformed value with
 *                 `invalid-input-remoteip` and that would refuse a good token.
 */
export async function verifyTurnstile(
  token: string | null | undefined,
  remoteIp?: string | null,
): Promise<TurnstileOutcome> {
  const secret = turnstileSecretKey();
  if (!secret || !turnstileSiteKey()) return { ok: true, status: "skipped" };

  const response = typeof token === "string" ? token.trim() : "";
  // Checked before the round trip: an empty `response` is an
  // `invalid-input-response` rejection anyway, and there is no reason to ask.
  //
  // The LENGTH cap matters more than it looks. Without it the submitter chooses
  // how many bytes we upload to Cloudflare, and a few hundred KB reliably earns
  // a 413 or blows the 5-second timeout — both of which land in the
  // "unreachable" branch below, which ALLOWS the submission. That turns
  // fail-open from an outage accommodation into a bypass anyone can trigger on
  // demand, and holds a Server Action worker for five seconds each time. Real
  // Turnstile tokens are well under 2 KB.
  if (!response || response.length > MAX_TOKEN_LENGTH) {
    return { ok: false, status: "missing" };
  }

  const body = new URLSearchParams({ secret, response });
  if (looksLikeIp(remoteIp ?? null)) body.set("remoteip", remoteIp!);

  try {
    const res = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      // Never cached: a token is single-use, and a cached "success" would make
      // one solved challenge reusable forever.
      cache: "no-store",
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error("[turnstile] siteverify returned", res.status);
      return { ok: true, status: "unreachable" };
    }
    const data = (await res.json()) as { success?: boolean; "error-codes"?: string[] };
    if (data.success === true) return { ok: true, status: "verified" };
    const codes = Array.isArray(data["error-codes"]) ? data["error-codes"] : [];
    if (codes.some((c) => NOT_THE_VISITORS_FAULT.includes(c))) {
      console.error("[turnstile] not the visitor's failure; allowing the submission:", codes);
      return { ok: true, status: "unreachable" };
    }
    return { ok: false, status: "rejected", codes };
  } catch (err) {
    // Timeout, DNS, TLS, or a body that was not JSON.
    console.error("[turnstile] siteverify unreachable; allowing the submission", err);
    return { ok: true, status: "unreachable" };
  }
}
