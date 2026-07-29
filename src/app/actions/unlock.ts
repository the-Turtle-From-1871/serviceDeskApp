"use server";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { verifyPin } from "@/lib/public-access";
import { recordAuthFailure } from "@/lib/auth-velocity";
import { THROTTLED } from "@/app/actions/throttled";
import {
  UNLOCK_POLICY,
  clientIp,
  consumeRateLimit,
  rateLimitKey,
} from "@/lib/rate-limit";
import {
  signUnlockValue,
  unlockCookieName,
  sanitizeNext,
  UNLOCK_MAX_AGE_SECONDS,
  UNLOCK_TTL_MS,
} from "@/lib/public-access-cookie";

// PUBLIC BY DESIGN: this is the one server action with no requireUser — it gates
// on the PIN itself. Verifies the 8-digit PIN against the bcrypt hash, then mints
// a 12-hour HMAC-signed unlock cookie the edge proxy can self-verify.
const schema = z.object({ pin: z.string().regex(/^\d{8}$/), next: z.string().optional() });

export async function unlockAction(_prev: unknown, formData: FormData) {
  const parsed = schema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Enter the 8-digit PIN." };

  // 20 attempts per 15 minutes per NETWORK, on top of the 400ms delay below.
  //
  // Every word of that is deliberate. There is no identity to narrow the key
  // with — the PIN is one 8-digit secret shared org-wide — so unlike sign-in
  // this bucket cannot be split per account, and it therefore covers everyone
  // on that egress. SUCCESSES COUNT: the token is spent before the bcrypt
  // compare (so concurrent guesses cannot all read an untouched bucket) and is
  // NOT handed back on a correct PIN, because emptying a shared bucket would
  // give an attacker on the same network a fresh budget every time a colleague
  // unlocked legitimately. That is why the budget is 20 rather than sign-in's
  // 5: at 5, the sixth soldier to unlock in a quarter of an hour was refused.
  //
  // 20 guesses per 15 minutes against 10^8, plus the delay, is still hopeless.
  const rlKey = rateLimitKey(UNLOCK_POLICY, clientIp(await headers()), "unlock");
  const gate = await consumeRateLimit(UNLOCK_POLICY, rlKey);
  if (!gate.allowed) {
    // Same wording as the auth actions, from the same helper — a hand-copied
    // duplicate drifts the moment one of them is reworded.
    return THROTTLED(gate.retryAfterSeconds);
  }

  let ok = false;
  try {
    ok = await verifyPin(parsed.data.pin);
  } catch (e) {
    console.error("[unlockAction] verifyPin failed:", e);
    return { error: "Something went wrong. Please try again." };
  }
  if (!ok) {
    // Counted app-wide as well as per-IP. The PIN is a single 8-digit secret
    // shared org-wide, so it is the smallest keyspace in the app and the most
    // attractive target for a distributed guess — precisely the population the
    // velocity detector was written for. Feeding it only from `loginAction`
    // left this surface able to be brute-forced without raising anything.
    await recordAuthFailure();
    // Slow down online guessing; also masks "no PIN set" vs "wrong PIN".
    await new Promise((r) => setTimeout(r, 400));
    return { error: "Incorrect PIN." };
  }

  const secret = process.env.AUTH_SECRET ?? "";
  const secure = process.env.NODE_ENV === "production";
  // Signing throws with no AUTH_SECRET (and Web Crypto throws on a zero-length
  // key regardless). Caught so a misconfigured deploy shows the form's error
  // text instead of rejecting the action's promise, which useActionState cannot
  // render — it escalates to the error boundary and the page breaks with a
  // digest. Detail stays server-side (CLAUDE.md §5).
  let value: string;
  try {
    value = await signUnlockValue(Date.now() + UNLOCK_TTL_MS, secret);
  } catch (e) {
    console.error("[unlockAction] could not sign the unlock cookie:", e);
    return { error: "Something went wrong. Please try again." };
  }
  const store = await cookies();
  store.set(unlockCookieName(secure), value, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: UNLOCK_MAX_AGE_SECONDS,
  });

  redirect(sanitizeNext(parsed.data.next));
}
