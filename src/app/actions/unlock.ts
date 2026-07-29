"use server";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { verifyPin } from "@/lib/public-access";
import {
  AUTH_POLICY,
  clientIp,
  consumeRateLimit,
  formatRetryAfter,
  rateLimitKey,
  resetRateLimit,
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

  // 5 WRONG PINs per 15 minutes per IP, on top of the 400ms delay below. The
  // delay alone only caps a SERIAL attacker; the limiter is what closes the
  // parallel case. Spend-then-refund like login (see `consumeRateLimit`): the
  // token is taken before the bcrypt compare so concurrent guesses cannot all
  // read an untouched bucket, and given back on a correct PIN so a shared
  // office IP is never locked out by people legitimately unlocking. This action
  // is public by design and has no session to key on, so the IP is the only
  // identifier available.
  const rlKey = rateLimitKey(AUTH_POLICY, clientIp(await headers()), "unlock");
  const gate = await consumeRateLimit(AUTH_POLICY, rlKey);
  if (!gate.allowed) {
    return {
      error: `Too many attempts from this network. Try again ${formatRetryAfter(gate.retryAfterSeconds)}.`,
    };
  }

  let ok = false;
  try {
    ok = await verifyPin(parsed.data.pin);
  } catch (e) {
    console.error("[unlockAction] verifyPin failed:", e);
    return { error: "Something went wrong. Please try again." };
  }
  if (!ok) {
    // Slow down online guessing; also masks "no PIN set" vs "wrong PIN".
    await new Promise((r) => setTimeout(r, 400));
    return { error: "Incorrect PIN." };
  }
  await resetRateLimit(AUTH_POLICY, rlKey);

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
