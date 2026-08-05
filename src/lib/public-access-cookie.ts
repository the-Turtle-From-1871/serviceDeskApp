// Imports nothing but @/lib/web-hmac, which is itself zero-import and uses only
// Web Crypto globals (crypto.subtle, btoa, TextEncoder) — so this file is safe
// to import from anywhere: the src/proxy.ts proxy (Node runtime in Next 16) and
// Node server actions alike.
// Web Crypto only — do NOT import bcrypt, Prisma, node:crypto, or server-only here.

import { hmac, safeEqual } from "@/lib/web-hmac";

export const UNLOCK_MAX_AGE_SECONDS = 12 * 60 * 60; // 12 hours
export const UNLOCK_TTL_MS = UNLOCK_MAX_AGE_SECONDS * 1000;

// The cookie is SIGNED on one serverless instance and VERIFIED on another, so
// their clocks need not agree to the millisecond. Without leeway the ceiling
// check below would refuse a just-minted cookie whenever the signing instance
// runs ahead, bouncing the visitor back to /unlock forever — a correct PIN
// would never stick.
//
// CHECK THIS AGAINST THE TTL IF YOU SHORTEN IT. The allowance is only free
// while it is small relative to the window: at a 12h TTL, 60s is noise. Cut the
// TTL to minutes and this becomes a meaningful fraction of it, widening how
// long a retired cookie stays acceptable. (It was originally justified against
// the one-off 7d→12h migration, where old cookies sat days past the ceiling —
// that argument expired with those cookies.)
export const UNLOCK_CLOCK_SKEW_MS = 60 * 1000;

// Mirror Auth.js's cookie-prefix convention: __Secure- over HTTPS.
export function unlockCookieName(secure: boolean): string {
  return secure ? "__Secure-pub_unlock" : "pub_unlock";
}

// Cookie value = "<expMs>.<hmac(secret, expMs)>". Self-contained so the edge
// proxy can verify it with no DB lookup.
export async function signUnlockValue(expMs: number, secret: string): Promise<string> {
  // Explicit, legible failure when there is no key.
  //
  // NOT a security fix: Web Crypto already refuses a zero-length HMAC key
  // (`DOMException: Zero-length key is not supported`), so a blank AUTH_SECRET
  // always threw here — it never signed with an empty key. This only replaces an
  // opaque DOMException from deep inside importKey with a message naming the
  // missing variable.
  if (!secret) throw new Error("AUTH_SECRET is required to sign a public-access unlock cookie");
  const sig = await hmac(secret, String(expMs));
  return `${expMs}.${sig}`;
}

/** Why a cookie was refused — the proxy needs this to decide whether to expire
 *  it in the browser. `retire` is true ONLY for a cookie whose signature we
 *  verified as genuinely ours but which is no longer usable. */
export type UnlockCheck = { valid: boolean; retire: boolean };

/**
 * Check an unlock cookie.
 *
 * ORDER IS LOAD-BEARING: the signature is verified BEFORE the expiry and
 * ceiling rules, so everything after that point is known to be a value this
 * server minted. That is what makes the `retire` signal safe to act on (the
 * proxy deletes the cookie from the browser) and the warning below trustworthy
 * — checking the ceiling first would let any stranger trigger both by pasting
 * `Cookie: pub_unlock=99999999999999.x`, which is unauthenticated log
 * amplification and an alarm anyone can spoof or drown.
 *
 * A missing secret returns `{valid:false}` rather than throwing. Web Crypto
 * already rejects a zero-length HMAC key, so the old code threw a DOMException
 * out of the proxy and 500'd every public page — closed, but as an outage. This
 * is the same refusal, legibly.
 */
export async function verifyUnlockValue(
  value: string | undefined,
  secret: string,
  nowMs: number,
): Promise<UnlockCheck> {
  const refuse: UnlockCheck = { valid: false, retire: false };
  if (!secret) return refuse;
  if (!value) return refuse;
  const dot = value.indexOf(".");
  if (dot <= 0) return refuse;
  const expStr = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (!sig) return refuse;
  const expMs = Number(expStr);
  if (!Number.isFinite(expMs)) return refuse;

  // Signature first — see the note above.
  const expected = await hmac(secret, expStr);
  if (!safeEqual(sig, expected)) return refuse;

  // From here the value is provably ours, so refusing it means retiring it.
  if (expMs <= nowMs) return { valid: false, retire: true };

  // Ceiling check, not just an expiry check: the lifetime is baked into the
  // SIGNED value at unlock time, so shortening UNLOCK_TTL_MS would otherwise
  // leave every already-issued cookie running on its old, longer window. A
  // cookie claiming more life than the current TTL allows is refused outright,
  // which retires the old ones the moment the shorter TTL ships.
  //
  // Note what this does NOT do: it only bites while a cookie claims MORE life
  // than the current TTL, so it retires long cookies when the TTL is shortened
  // and does nothing otherwise. It is not a revocation lever — PIN rotation
  // stays non-retroactive (see docs/SECURITY.md, Known gaps).
  if (expMs - nowMs > UNLOCK_TTL_MS + UNLOCK_CLOCK_SKEW_MS) {
    // Reachable only with a genuine signature, so this cannot be triggered by a
    // stranger. It means either a cookie from a longer TTL (expected — the
    // retirement working) or clock skew beyond the allowance, and the latter
    // locks every logged-out visitor into a redirect loop otherwise
    // indistinguishable from a wrong PIN. No secret is logged, only the margin.
    console.warn(
      `[public-access] refused unlock cookie claiming ${Math.round((expMs - nowMs) / 1000)}s of life; ceiling is ${(UNLOCK_TTL_MS + UNLOCK_CLOCK_SKEW_MS) / 1000}s`,
    );
    return { valid: false, retire: true };
  }
  return { valid: true, retire: false };
}

// Only a same-origin relative path is a safe redirect target (prevents open
// redirect). Reject the unlock page itself to avoid a pointless self-redirect.
export function sanitizeNext(next: string | null | undefined): string {
  if (typeof next !== "string") return "/";
  // Reject control chars (incl. tab/newline/CR) and backslashes — browsers may
  // strip or normalize them into a protocol-relative `//host` open redirect.
  if (/[\x00-\x1F\x7F]/.test(next)) return "/";
  if (next.includes("\\")) return "/";
  if (!next.startsWith("/")) return "/";
  if (next.startsWith("//") || next.startsWith("/\\")) return "/";
  if (next === "/unlock" || next.startsWith("/unlock?") || next.startsWith("/unlock/")) return "/";
  return next;
}

export function shouldAllowPublic(opts: {
  flagEnabled: boolean;
  loggedIn: boolean;
  unlockValid: boolean;
}): boolean {
  if (!opts.flagEnabled) return true; // gate disabled -> behave like today
  return opts.loggedIn || opts.unlockValid;
}
