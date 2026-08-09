"use server";
import { AuthError } from "next-auth";
import { after } from "next/server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { signIn, signOut } from "@/auth";
import { EMAIL_NOT_VERIFIED } from "@/modules/auth/credentials";
import prisma from "@/lib/prisma";
import { emailField, passwordField, registerSchema } from "@/modules/users/users.schema";
import { createSelfRegisteredUser } from "@/modules/users/users.service";
import { createEmailVerificationToken } from "@/lib/email-verification";
import { sendVerificationEmail } from "@/modules/auth/send-verification-email";
import { createPasswordResetToken, resetPasswordWithToken } from "@/lib/password-reset";
import { sendPasswordResetEmail } from "@/modules/auth/send-password-reset-email";
import { defaultBaseUrl } from "@/lib/base-url";
import { authVelocityElevated, recordAuthFailure } from "@/lib/auth-velocity";
import { TURNSTILE_FIELD, turnstileConfigured, verifyTurnstile } from "@/lib/turnstile";
import { THROTTLED } from "@/app/actions/throttled";
import {
  AUTH_POLICY,
  AUTH_SPRAY_POLICY,
  clientIp,
  consumeRateLimit,
  rateLimitIdentity,
  rateLimitKey,
  resetRateLimit,
} from "@/lib/rate-limit";

// Minimum interval between reset emails for a single account (per-account
// cooldown) — throttles email-bombing of a known address.
const RESET_COOLDOWN_MS = 60_000;

// These actions are the interactive half of the auth rate limit; the proxy
// covers `/api/auth/*`. They are limited HERE rather than in the proxy because a
// 429 to a Server Action POST is not a message — `useActionState` cannot render
// it, so it escalates to the error boundary and the page breaks with a digest
// (the same failure mode `unlockAction` documents for a rejected promise).
// Returning `{ error }` keeps the refusal inside the form.

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

/**
 * Shown for a refused challenge — deliberately not "you look like a bot".
 *
 * A FUNCTION, not a shared object — the identity has to change every time.
 *
 * `useActionState` hands the returned value to the form as `state`, and the
 * forms pass it to the widget as `resetOn`. Returning one module-level object
 * meant two consecutive challenge failures produced the SAME identity, React
 * bailed out of the reset effect, `turnstile.reset()` never ran, and every
 * later submit re-sent the token Cloudflare had already spent — refused as
 * `timeout-or-duplicate` forever, recoverable only by reloading the page.
 * Every other return in this file is a fresh object literal; this was the one
 * singleton.
 */
const CHALLENGE_FAILED = () => ({
  // Names the likely cause and gives a route out, because for one population
  // this is not a transient failure: a browser that cannot reach
  // `challenges.cloudflare.com` will never produce a token, and "please try
  // again" would be advice that cannot work. See the failure-posture note in
  // `src/lib/turnstile.ts`.
  error:
    "Could not verify that this request came from a browser. If your network blocks " +
    "Cloudflare, this check cannot complete — contact the service desk.",
});

/**
 * Is the challenge configured but the form carrying nothing?
 *
 * Deliberately does NOT verify — verifying spends the token, and a token may
 * only be presented to Cloudflare once.
 */
function missingTurnstileToken(formData: FormData): boolean {
  if (!turnstileConfigured()) return false;
  return String(formData.get(TURNSTILE_FIELD) ?? "").trim() === "";
}

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
    return CHALLENGE_FAILED();
  }
  return outcome.ok ? null : CHALLENGE_FAILED();
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
  // Scope `"login"` is this action's alone. The proxy meters `/api/auth/*`
  // writes under `api-auth-write`: sharing the scope meant 60 unauthenticated
  // `POST /api/auth/signout` calls could lock the whole desk out of sign-in.
  const email = String(formData.get("email") ?? "");

  // Shape-check BEFORE spending anything.
  //
  // Ordering matters twice over. It keeps a malformed address away from the
  // velocity detector (below), and — the sharper one — it stops 60 junk POSTs
  // draining the shared per-network ceiling: every distinct junk value hashes
  // to its own fresh narrow bucket, so all 60 sail past the per-account gate
  // and charge the ceiling, locking every colleague behind that egress out of
  // sign-in. Same whole-desk lockout as the shared-scope bug, reached through
  // the one gate that was still upstream of the budget.
  if (!emailField.safeParse(email).success) {
    return { error: "Invalid email or password." };
  }

  // A submission carrying NO token at all is refused before the budget, not
  // after — and by a presence check, NOT by running the challenge early. The
  // token is single-use, so verifying it twice would spend it and make the
  // second look forged.
  //
  // Free to detect, and charging for it would double-punish the one population
  // that can never succeed: a visitor whose network blocks
  // `challenges.cloudflare.com` produces no token on every attempt, so after
  // five they would swap an unrecoverable challenge error for an unrecoverable
  // 15-minute throttle — and burn the account's budget for everyone else on
  // that egress. A token that exists but is wrong still pays.
  if (missingTurnstileToken(formData)) return CHALLENGE_FAILED();

  const keys = await identityRateLimitKeys("login", email);
  const throttled = await spendAuthBudget(keys);
  if (throttled) return throttled;

  //
  // `authorize()` runs the same Zod check and returns null, which @auth/core
  // turns into a `CredentialsSignin` — indistinguishable below from a wrong
  // password, so `email=x` used to record a global auth failure having touched
  // neither the database nor bcrypt. That is a near-free lever on an app-wide
  // escalation: two hosts rotating junk addresses could flip Turnstile to
  // strict for everyone in seconds. The detector's rule is "genuinely failed
  // credential checks only", and this is what makes the code honour it.
  if (!emailField.safeParse(email).success) {
    return { error: "Invalid email or password." };
  }

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
  // No browser form sends this header; only a crafted request does. It has
  // already cost a rate-limit token above, which is the right price — it is NOT
  // reported to the velocity detector, because no password was checked and
  // "cheap request raises the app-wide alarm" is the lever that turns the
  // detector into the vulnerability.
  if ((await headers()).has("x-auth-return-redirect")) {
    console.error("[loginAction] refused a request carrying X-Auth-Return-Redirect");
    return { error: "Invalid email or password." };
  }

  // After the limiter (a refused request must cost as little as possible) and
  // before the password check (the challenge exists to keep headless scripts
  // away from bcrypt at all).
  const refused = await challenge(formData, keys.ip);
  if (refused) return refused;

  // `redirect: false`, so success and failure are a RETURN VALUE rather than a
  // thrown redirect this action has to interpret.
  //
  // Inferring "signed in" from "a NEXT_REDIRECT was thrown" is an assumption
  // about @auth/core internals, not a contract — and it has already been wrong
  // once: the `X-Auth-Return-Redirect` guard above exists because that header
  // converts a failed credential check into a redirect. Blacklisting one header
  // closes today's instance; any future change that turns an AuthError into a
  // redirect re-opens it silently, and this is a beta dependency. Deciding from
  // the outcome removes the ambiguity instead of enumerating its triggers.
  let destination: string;
  try {
    destination = await signIn("credentials", {
      email,
      password: formData.get("password"),
      redirect: false,
      redirectTo: "/items",
    });
  } catch (error) {
    if (error instanceof AuthError) {
      // Right password, unconfirmed address. NOT a credential failure: the
      // bcrypt compare succeeded, so counting it would let ordinary sign-up
      // traffic drive the app-wide botnet escalation. The rate-limit token
      // stays spent — this is still a failed sign-in attempt — but the message
      // is specific, which is safe precisely because reaching it required the
      // correct password.
      if ((error as { code?: string }).code === EMAIL_NOT_VERIFIED) {
        return { unverified: true as const, email };
      }
      // A real credential check that came back wrong — the only thing the
      // escalation should count. Throttled, malformed and challenge-refused
      // submissions never reached a password, so counting them would let an
      // attacker raise the alarm without guessing anything.
      await recordAuthFailure("login");
      return { error: "Invalid email or password." };
    }
    // Anything else is an unexpected server failure — a Postgres blip inside
    // `authorize()`, say. It keeps its tokens (a crash is not evidence the
    // credentials were right) but it must NOT be re-thrown: with
    // `redirect: false` there is no NEXT_REDIRECT left for `signIn` to raise,
    // so the only thing a rethrow can do now is escalate to the error boundary
    // and replace the form with a digest. `unlockAction` and
    // `resetPasswordAction` both return the generic message here; CLAUDE.md §5
    // requires it.
    console.error("[loginAction] sign-in failed unexpectedly:", error);
    return { error: "Something went wrong. Please try again." };
  }

  // The other shape of failure: @auth/core returned an error URL instead of
  // throwing. Treated identically to a thrown AuthError.
  if (/[?&]error=/.test(destination)) {
    // Same two cases as the thrown branch above, and for the same reasons.
    if (destination.includes(`code=${EMAIL_NOT_VERIFIED}`)) {
      return { unverified: true as const, email };
    }
    await recordAuthFailure("login");
    return { error: "Invalid email or password." };
  }

  // Success. Refund ONLY the narrow bucket — it belongs to this account on this
  // network, so clearing it is precise. The per-network ceiling is SHARED;
  // refunding that would let anyone holding one valid credential wipe
  // everybody's counter between guesses.
  await resetRateLimit(AUTH_POLICY, keys.narrow);
  redirect(destination);
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
  // Keyed on the TOKEN, not just the network. A bare `(scope, ip)` bucket is
  // the single-bucket-per-IP design `loginAction` documents as punishing the
  // wrong people: five colleagues clicking yesterday expired reset links would
  // lock out the sixth, who is holding a perfectly valid one. The token is a
  // usable identity, and `rateLimitIdentity` hashes it — required here, not
  // optional, because the raw value is itself a secret.
  const keys = await identityRateLimitKeys("reset-submit", token);
  const throttled = await spendAuthBudget(keys);
  if (throttled) return throttled;

  // The one surface where a correct guess is an outright account takeover, and
  // it was the only auth action with no challenge in front of it.
  const refused = await challenge(formData, keys.ip);
  if (refused) return refused;

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
    // No refund on success, and not because it would be unsafe — because it
    // would be pointless. The bucket is keyed on the token hash, and a
    // successful reset CONSUMES the token, so the freed attempts can never be
    // spent by anyone. All it would buy is the O(keyspace) Redis `SCAN` that
    // `resetRateLimit` warns about. (Contrast the login refund, which is
    // genuinely reusable: the email persists.)
  } catch (e) {
    console.error("[resetPasswordAction] error:", e);
    return { error: "Something went wrong. Please try again." };
  }
  return { ok: true as const };
}


// PUBLIC BY DESIGN: registration is an unauthenticated entry point, like login
// and the reset request (a reviewed exception to "auth-first").
//
// Modelled on requestPasswordResetAction, NOT on loginAction, and the difference
// is the point: there is no "failed attempt" to charge here and nothing is ever
// refunded, because with registration the abuse IS volume. Copying login's
// refund would make the budget effectively unlimited for anyone willing to
// succeed once.
export async function registerAction(_prev: unknown, formData: FormData) {
  // Shape-check BEFORE spending anything — the same ordering rule as
  // loginAction. Junk must not reach the budget, or 60 malformed POSTs drain
  // the shared per-network ceiling and lock out every colleague behind that
  // egress.
  const parsed = registerSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the form and try again." };
  }
  const input = parsed.data;

  // Free to detect, and charging for it would double-punish the one population
  // that can never succeed: a visitor whose network blocks Cloudflare produces
  // no token on every attempt.
  if (missingTurnstileToken(formData)) return CHALLENGE_FAILED();

  const keys = await identityRateLimitKeys("register", input.email);
  const throttled = await spendAuthBudget(keys);
  if (throttled) return throttled;

  const refused = await challenge(formData, keys.ip);
  if (refused) return refused;

  // Everything that could reveal whether this address is already registered runs
  // AFTER the response, so the action returns in ~constant time either way and
  // the value below is identical for every outcome. Same construction, and same
  // reason, as requestPasswordResetAction.
  after(async () => {
    try {
      const base = defaultBaseUrl().replace(/\/$/, "");
      if (!base) {
        console.error("[registerAction] no base URL configured (set APP_URL); skipping verification email");
        return;
      }

      const existing = await prisma.user.findUnique({ where: { email: input.email } });
      if (existing) {
        // Deliberately NOT a second account, and deliberately not an error the
        // submitter can see: telling them the address is taken is precisely the
        // enumeration oracle the deferral above exists to close.
        console.info("[registerAction] registration attempted for an address that already exists");
        return;
      }

      const user = await createSelfRegisteredUser(input);
      const raw = await createEmailVerificationToken(user.id);
      await sendVerificationEmail({
        to: user.email,
        name: user.name,
        verifyUrl: `${base}/verify-email?token=${raw}`,
      });
    } catch (e) {
      console.error("[registerAction] deferred work failed:", e);
    }
  });

  return { ok: true as const };
}


// Re-sends the confirmation link. Its OWN rate-limit scope: sharing
// "register" would let a resend flood spend the budget that stops
// account-creation spam, and vice versa — one capability, one scope.
//
// Generic and deferred for the same anti-enumeration reason as registration,
// and it NEVER refunds: volume is the abuse here too.
export async function resendVerificationAction(_prev: unknown, formData: FormData) {
  const parsed = emailField.safeParse(String(formData.get("email") ?? ""));
  if (!parsed.success) return { error: "Enter a valid email address." };
  const email = parsed.data;

  const keys = await identityRateLimitKeys("verify-resend", email);
  const throttled = await spendAuthBudget(keys);
  if (throttled) return throttled;

  after(async () => {
    try {
      const base = defaultBaseUrl().replace(/\/$/, "");
      if (!base) {
        console.error("[resendVerificationAction] no base URL configured (set APP_URL); skipping");
        return;
      }
      const user = await prisma.user.findUnique({ where: { email } });
      // Silently no-op for unknown, inactive, and ALREADY-VERIFIED accounts —
      // re-sending to a confirmed address would let anyone mail-bomb a known
      // user through a form that reports nothing back.
      if (!user || !user.isActive || user.emailVerifiedAt) return;

      const raw = await createEmailVerificationToken(user.id);
      await sendVerificationEmail({
        to: user.email,
        name: user.name,
        verifyUrl: `${base}/verify-email?token=${raw}`,
      });
    } catch (e) {
      console.error("[resendVerificationAction] deferred work failed:", e);
    }
  });

  return { ok: true as const };
}
