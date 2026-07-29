"use server";
import { AuthError } from "next-auth";
import { after } from "next/server";
import { headers } from "next/headers";
import { signIn, signOut } from "@/auth";
import prisma from "@/lib/prisma";
import { emailField, passwordField } from "@/modules/users/users.schema";
import { createPasswordResetToken, resetPasswordWithToken } from "@/lib/password-reset";
import { sendPasswordResetEmail } from "@/modules/auth/send-password-reset-email";
import { defaultBaseUrl } from "@/lib/base-url";
import { authVelocityElevated, recordAuthFailure } from "@/lib/auth-velocity";
import { TURNSTILE_FIELD, verifyTurnstile } from "@/lib/turnstile";
import {
  AUTH_POLICY,
  AUTH_SPRAY_POLICY,
  clientIp,
  consumeRateLimit,
  formatRetryAfter,
  rateLimitIdentity,
  rateLimitKey,
  resetRateLimit,
} from "@/lib/rate-limit";

// Minimum interval between reset emails for a single account (per-account
// cooldown) — throttles email-bombing of a known address.
const RESET_COOLDOWN_MS = 60_000;

// These three actions are the interactive half of the auth rate limit; the
// proxy covers `/api/auth/*`. They are limited HERE rather than in the proxy
// because a 429 to a Server Action POST is not a message — `useActionState`
// cannot render it, so it escalates to the error boundary and the page breaks
// with a digest (the same failure mode `unlockAction` documents for a rejected
// promise). Returning `{ error }` keeps the refusal inside the form.
async function authRateLimitKey(scope: string) {
  return rateLimitKey(AUTH_POLICY, clientIp(await headers()), scope);
}

/**
 * The pair of buckets an identity-bearing auth surface spends from:
 * `narrow` is (scope, network, account) at 5, `spray` is (scope, network) at 60.
 *
 * Both are required. The narrow bucket alone is not a limit — the email is
 * attacker-supplied, so rotating it mints a fresh one. The spray bucket alone
 * punishes the wrong people: the service desk shares one NAT egress IP, so one
 * person mistyping their password would spend everyone's budget.
 */
async function identityRateLimitKeys(scope: string, email: string) {
  const ip = clientIp(await headers());
  return {
    ip,
    narrow: rateLimitKey(AUTH_POLICY, ip, scope, await rateLimitIdentity(email)),
    spray: rateLimitKey(AUTH_SPRAY_POLICY, ip, scope),
  };
}

const THROTTLED = (retryAfterSeconds: number) => ({
  error: `Too many attempts from this network. Try again ${formatRetryAfter(retryAfterSeconds)}.`,
});

/**
 * Spend one attempt from the pair of buckets, in the ONE order that is safe.
 *
 * Narrow (per-account) FIRST. Reversed, twenty cheap requests naming a single
 * address would drain the shared per-network ceiling — fifteen of them refused
 * by the narrow bucket but still charged to the ceiling — and lock every
 * colleague behind that egress out of sign-in for fifteen minutes. That is
 * exactly the failure the composite key exists to prevent, so the ceiling is
 * only ever charged for attempts that got past the per-account gate.
 */
async function spendAuthBudget(keys: { narrow: string; spray: string }) {
  const gate = await consumeRateLimit(AUTH_POLICY, keys.narrow);
  if (!gate.allowed) return THROTTLED(gate.retryAfterSeconds);

  const spray = await consumeRateLimit(AUTH_SPRAY_POLICY, keys.spray);
  // The narrow token is NOT handed back here, even though this attempt never
  // reached a password. `resetRateLimit` empties a bucket rather than
  // decrementing it, and that turns into a bypass: an attacker who saturates
  // the shared ceiling with throwaway addresses makes every subsequent attempt
  // against a real account wipe that account's failure count, so the effective
  // per-account guess rate becomes the ceiling (60) instead of 5. It would also
  // put an O(keyspace) Redis SCAN on a path an unauthenticated caller controls.
  // Over-charging one token during an attack is the cheap, safe direction.
  if (!spray.allowed) return THROTTLED(spray.retryAfterSeconds);
  return null;
}

/** Shown for a refused challenge. Deliberately not "you look like a bot". */
const CHALLENGE_FAILED = {
  error: "Could not verify that request came from a browser. Please try again.",
};

/**
 * Run the Turnstile check for one submission.
 *
 * Returns null to proceed. The only judgement here is what to do when
 * Cloudflare cannot be reached: normally proceed (a third-party outage must not
 * lock the service desk out of its own property book), but refuse while the
 * global failure velocity is elevated — during a distributed attack an
 * unverifiable submission is not worth the benefit of the doubt. See
 * `src/lib/auth-velocity.ts`.
 */
async function challenge(formData: FormData, ip: string | null) {
  const outcome = await verifyTurnstile(String(formData.get(TURNSTILE_FIELD) ?? ""), ip);
  if (outcome.ok && outcome.status === "unreachable" && (await authVelocityElevated())) {
    console.error("[turnstile] refusing an unverifiable submission: auth velocity is elevated");
    return CHALLENGE_FAILED;
  }
  return outcome.ok ? null : CHALLENGE_FAILED;
}

/**
 * Next signals a successful `redirect()` by throwing. The marker is the
 * `digest`, not the class — `signIn` re-throws Next's own error object, so
 * there is nothing to `instanceof`.
 */
function isRedirect(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { digest?: unknown }).digest === "string" &&
    (error as { digest: string }).digest.startsWith("NEXT_REDIRECT")
  );
}

// PUBLIC BY DESIGN: login/register are the unauthenticated entry to the auth
// flow — they cannot require a session (reviewed exception to "auth-first").
export async function loginAction(_prev: unknown, formData: FormData) {
  // Spend the token BEFORE the password check, and give it back when the
  // sign-in succeeds. Checking first and charging only failures reads better
  // but is a time-of-check/time-of-use hole exactly as wide as the bcrypt
  // compare: 500 concurrent POSTs would all see an untouched bucket and all be
  // admitted. The refund is what keeps this a *failure* budget — the service
  // desk shares one NAT egress IP, so charging successful sign-ins would take
  // the whole desk offline after five people logged in.
  //
  // Scope `"login"` is shared with the `/api/auth/*` mutation gate in
  // `src/proxy.ts`: same capability, two surfaces, one budget.
  const email = String(formData.get("email") ?? "");
  const keys = await identityRateLimitKeys("login", email);
  const throttled = await spendAuthBudget(keys);
  if (throttled) return throttled;

  // `signIn()` copies the INCOMING request headers into the request it hands to
  // @auth/core (`new Headers(await nextHeaders())`, next-auth/lib/actions.js),
  // and @auth/core treats `X-Auth-Return-Redirect` as "return the error instead
  // of throwing it" (`if (isAuthError && isRaw && !isRedirect) throw error`).
  //
  // So a crafted login POST carrying that one header turns a WRONG password
  // into a NEXT_REDIRECT — which the catch below would read as success: it
  // would hand the rate-limit token back and never tell the botnet detector
  // anything. Unlimited per-account guessing, silently.
  //
  // No browser form sends this header; only a crafted request does. It is
  // charged as a failed attempt rather than merely ignored, so probing costs
  // the same as guessing.
  if ((await headers()).has("x-auth-return-redirect")) {
    console.error("[loginAction] refused a request carrying X-Auth-Return-Redirect");
    await recordAuthFailure();
    return { error: "Invalid email or password." };
  }

  // After the limiter (a refused request must cost as little as possible) and
  // before the password check (the challenge exists to keep headless scripts
  // away from bcrypt at all).
  const refused = await challenge(formData, keys.ip);
  if (refused) return refused;

  try {
    await signIn("credentials", {
      email,
      password: formData.get("password"),
      redirectTo: "/items",
    });
  } catch (error) {
    if (error instanceof AuthError) {
      // A real credential check that came back wrong — the only thing the
      // global detector should count. Throttled, malformed and challenge-
      // refused submissions never reached a password, so counting them would
      // let an attacker raise the alarm without guessing anything.
      await recordAuthFailure();
      return { error: "Invalid email or password." };
    }
    // A successful sign-in leaves through here: `signIn` throws NEXT_REDIRECT.
    // Refund BOTH before re-throwing, or the redirect skips it. Narrowed to the
    // redirect specifically — an unexpected server error is not evidence the
    // credentials were right, so it keeps its tokens, which is the safe
    // direction.
    // ONLY the narrow bucket. It belongs to this account on this network, so
    // clearing it is precise. The per-network ceiling is SHARED — refunding it
    // would let anyone holding one valid credential wipe everybody's counter
    // between guesses, and the ceiling would stop meaning anything.
    if (isRedirect(error)) await resetRateLimit(AUTH_POLICY, keys.narrow);
    throw error; // re-throw Next.js redirect
  }
}

export async function logoutAction() {
  await signOut({ redirectTo: "/" });
}

// Emails a reset link to the account (if one exists). Always returns a generic
// success so it never reveals whether an email is registered.
export async function requestPasswordResetAction(_prev: unknown, formData: FormData) {
  // FIX #12: validate/normalize the email through the shared Zod field
  // (trims + lowercases + verifies it is a real email) instead of a hand-rolled
  // `.includes("@")` check.
  const parsed = emailField.safeParse(String(formData.get("email") ?? ""));
  if (!parsed.success) return { error: "Enter a valid email address." };
  const email = parsed.data;

  // Unlike login there is no "failed attempt" to charge and nothing is ever
  // refunded — every well-formed request costs a token, because the abuse here
  // is volume itself. The two buckets answer the two shapes of that abuse:
  // the narrow one caps mail-bombing ONE address, the spray one caps walking a
  // list of addresses from one network. Consumed BEFORE the deferred work is
  // scheduled, and the refusal is IP-shaped rather than account-shaped, so it
  // still says nothing about whether the address is registered.
  const keys = await identityRateLimitKeys("reset-request", email);
  const throttled = await spendAuthBudget(keys);
  if (throttled) return throttled;

  // Checked before anything is scheduled. A refused challenge returns its own
  // message rather than the generic success — that reveals nothing about the
  // address, only that the request did not look like a browser.
  const refused = await challenge(formData, keys.ip);
  if (refused) return refused;

  // FIX #2 (timing side-channel): schedule the account lookup + token creation +
  // email send to run AFTER the response is sent, then return the generic success
  // immediately. This makes the action return in ~constant time regardless of
  // whether the account exists, defeating enumeration via response timing.
  after(async () => {
    try {
      const user = await prisma.user.findUnique({ where: { email } });
      // Silently no-op for unknown/inactive accounts (anti-enumeration).
      if (!user || !user.isActive) return;

      // FIX #1 (per-account cooldown): if a still-usable reset was created for
      // this account within the cooldown window, skip sending another one.
      const recent = await prisma.passwordResetToken.findFirst({
        where: { userId: user.id, usedAt: null },
        orderBy: { createdAt: "desc" },
      });
      if (recent && Date.now() - recent.createdAt.getTime() < RESET_COOLDOWN_MS) return;

      // FIX #3 (base-url guard): never send a broken relative link. If no origin
      // is configured, log server-side and skip the send.
      const base = defaultBaseUrl().replace(/\/$/, "");
      if (!base) {
        console.error("[requestPasswordResetAction] no base URL configured (set APP_URL); skipping reset email");
        return;
      }

      const raw = await createPasswordResetToken(user.id);
      await sendPasswordResetEmail({
        to: user.email,
        name: user.name,
        resetUrl: `${base}/reset-password?token=${raw}`,
      });
    } catch (e) {
      // Server-side-only logging; the client already received generic success.
      console.error("[requestPasswordResetAction] deferred work failed:", e);
    }
  });

  return { ok: true as const };
}

// Sets a new password from a valid reset token.
export async function resetPasswordAction(_prev: unknown, formData: FormData) {
  const token = String(formData.get("token") ?? "");
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  // FIX #9: validate the password through the shared Zod field instead of a
  // manual length check.
  const parsed = passwordField.safeParse(password);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Password must be at least 8 characters." };
  if (password !== confirm) return { error: "Passwords do not match." };
  if (!token) return { error: "This reset link is invalid or has expired." };

  // Same spend-then-refund shape as login, and for the same reason: charging
  // only after the token lookup fails would leave a concurrency window. Checked
  // after the cheap validation above so a mistyped confirmation is not an
  // "attempt".
  const key = await authRateLimitKey("reset-submit");
  const gate = await consumeRateLimit(AUTH_POLICY, key);
  if (!gate.allowed) return THROTTLED(gate.retryAfterSeconds);

  try {
    const ok = await resetPasswordWithToken(token, password);
    if (!ok) {
      // Counted app-wide: guessing reset tokens is credential guessing, and a
      // botnet spread thin enough to stay under every per-IP bucket is exactly
      // what the detector exists for. Feeding it only from `loginAction` left
      // this surface able to be brute-forced without raising anything.
      await recordAuthFailure();
      return { error: "This reset link is invalid or has expired." };
    }
    await resetRateLimit(AUTH_POLICY, key);
  } catch (e) {
    console.error("[resetPasswordAction] error:", e);
    return { error: "Something went wrong. Please try again." };
  }
  return { ok: true as const };
}
