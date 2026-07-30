// Global authentication-failure velocity — the distributed-botnet detector.
//
// The per-IP and per-account limits in `rate-limit.ts` are blind to the attack
// they are least able to stop: ten thousand hosts each making four attempts.
// Every individual bucket stays comfortably under its budget while the app as a
// whole is being brute-forced. What gives that away is not any single caller
// but the AGGREGATE rate of failures, so this counts failures app-wide, on one
// shared key, and reports when the rate is abnormal.
//
// ── What "elevated" does ─────────────────────────────────────────────────────
// It deliberately does NOT block, and it must not: a global refusal is a global
// outage that any attacker could trigger on purpose, which would turn the
// detector into the vulnerability. Instead it does two things:
//
//   1. Logs a structured alert (rate-limited to one per cooldown, or the alert
//      itself becomes the flood) for a human to act on.
//   2. Makes Cloudflare Turnstile STRICT — see `src/lib/turnstile.ts`. Normally
//      an unreachable Cloudflare lets the submission through, because a third-
//      party outage should not lock the service desk out of its own property
//      book. While a distributed attack is in progress that trade flips: an
//      unverifiable sign-in is refused. A real technician retries in a minute;
//      a botnet does not get a free pass because Cloudflare had a bad day.
//
// So the detector's teeth are the CAPTCHA. With no Turnstile keys configured it
// is alerting only, which is worth having but is not a mitigation.
import {
  consumeRateLimit,
  readRateLimit,
  type RateLimitPolicy,
} from "@/lib/rate-limit";

/**
 * The threshold. Not a budget anyone is entitled to spend — it is the point at
 * which the failure rate stops looking like people mistyping passwords.
 *
 * 100 failures in 5 minutes across the WHOLE app. For scale: this deployment
 * has on the order of tens of accounts, and a normal day produces single-digit
 * failures. A distributed attack producing fewer than 20 failures a minute is
 * also making no progress against bcrypt cost 12.
 */
export const AUTH_VELOCITY_POLICY: RateLimitPolicy = {
  name: "auth-velocity",
  limit: 100,
  windowSeconds: 5 * 60,
};

/**
 * Two buckets, because the detector has two jobs and only one of them may be
 * attacker-triggerable.
 *
 * `AUTH_VELOCITY_KEY` counts EVERY guessable surface — sign-in, a wrong PIN at
 * `/unlock`, a bad reset token — and drives the alert. Broad is right here: a
 * false alarm costs a log line, and a blind spot costs the whole point of the
 * feature.
 *
 * `AUTH_VELOCITY_LOGIN_KEY` counts sign-in failures only and is the ONLY thing
 * that drives the escalation (strict Turnstile). `/unlock` needs no account and
 * carries no challenge of its own, so letting it raise the escalation would
 * hand an unauthenticated attacker a cheap global switch: fill the bucket, and
 * every sign-in whose Turnstile verification is `unreachable` is refused
 * app-wide. That is the failure this module's own header warns about — "a
 * global refusal is a global outage that any attacker could trigger on purpose,
 * which would turn the detector into the vulnerability" — and it is why the two
 * jobs do not share a counter.
 */
export const AUTH_VELOCITY_KEY = "auth-velocity:global";
export const AUTH_VELOCITY_LOGIN_KEY = "auth-velocity:login";

/** Which surface a failure came from. Only `login` can raise the escalation. */
export type AuthFailureSurface = "login" | "other";

/** Minimum gap between alert lines, so the alarm cannot become the flood. */
const ALERT_COOLDOWN_MS = 60_000;
let lastAlertAt = 0;

/** Epoch ms until which the escalation stays on regardless of the bucket edge. */
let elevatedUntil = 0;

/** Test seam. */
export function __resetAuthVelocityStateForTests() {
  lastAlertAt = 0;
  elevatedUntil = 0;
}

/**
 * Record one failed authentication, app-wide.
 *
 * Call it on a genuinely failed credential check — not on a throttled request
 * (which never reached a password) and not on a malformed submission, or the
 * detector measures its own limiter rather than the attack.
 *
 * @returns whether the app is now in the elevated state.
 */
export async function recordAuthFailure(surface: AuthFailureSurface = "other"): Promise<boolean> {
  // The bucket holds `limit` failures per window, so exhausting it IS the
  // threshold crossing — and the state then clears on its own once failures
  // stop, with no separate expiry to maintain.
  //
  // `remaining === 0` rather than only `!allowed`: the failure that empties the
  // bucket is itself permitted, so keying on refusal alone would report the
  // threshold one attempt late and disagree with `authVelocityElevated`, which
  // reads the same bucket. Two functions naming one state must agree about
  // when it starts.
  const verdict = await consumeRateLimit(AUTH_VELOCITY_POLICY, AUTH_VELOCITY_KEY);
  const alerting = !verdict.allowed || verdict.remaining === 0;
  if (alerting) alertOnce();

  if (surface !== "login") return alerting;

  // Sign-in failures additionally feed the bucket that can flip Turnstile to
  // strict. Latched: once crossed, the state holds for a full window rather
  // than tracking the bucket edge. Without the latch it flickers — refused hits
  // are deliberately not recorded, so at exactly the threshold the moment the
  // oldest entry ages out `remaining` becomes 1 and the mitigation switches off
  // until the next failure refills it, waving through roughly half the
  // unverifiable submissions it exists to refuse.
  const login = await consumeRateLimit(AUTH_VELOCITY_POLICY, AUTH_VELOCITY_LOGIN_KEY);
  if (!login.allowed || login.remaining === 0) {
    elevatedUntil = Date.now() + AUTH_VELOCITY_POLICY.windowSeconds * 1000;
    alertOnce();
    return true;
  }
  return alerting;
}

/**
 * Is the app currently seeing an abnormal rate of auth failures?
 *
 * Advisory and one attempt stale by construction — see `readRateLimit`. Fails
 * open (reports false) so a store outage cannot put the app into a stricter
 * mode nobody asked for.
 */
export async function authVelocityElevated(): Promise<boolean> {
  // The latch first: it is what gives the mitigation hysteresis, and it is free
  // to read. It is per-instance, which is the same limitation everything else
  // in the in-memory fallback has; the bucket read below is the shared signal.
  if (Date.now() < elevatedUntil) return true;
  const verdict = await readRateLimit(AUTH_VELOCITY_POLICY, AUTH_VELOCITY_LOGIN_KEY);
  return !verdict.allowed;
}

function alertOnce() {
  const now = Date.now();
  if (now - lastAlertAt < ALERT_COOLDOWN_MS) return;
  lastAlertAt = now;
  // Structured single line, so a log drain can alert on it without parsing prose.
  console.error(
    JSON.stringify({
      event: "auth.velocity.elevated",
      threshold: AUTH_VELOCITY_POLICY.limit,
      windowSeconds: AUTH_VELOCITY_POLICY.windowSeconds,
      message:
        "Application-wide authentication failures exceeded the threshold — " +
        "possible distributed credential attack. Turnstile is now strict.",
    }),
  );
}
