// Imports nothing but @/lib/web-hmac, which is itself zero-import and uses only
// Web Crypto globals — so this file is safe to import from src/proxy.ts.
// Web Crypto only — do NOT import bcrypt, Prisma, node:crypto, or server-only here.
import { hmac, safeEqual } from "@/lib/web-hmac";

/**
 * A capability token for ONE hand receipt, carried in the links we generate for
 * it (the notification emails, and the QR printed on the DA 2062). Holding it
 * lets a logged-out visitor read that receipt without the shared 8-digit PIN.
 *
 * It names a RECEIPT, not a person, and it does not expire — see
 * docs/SECURITY.md §3 and its Known gaps entry for what that costs.
 */

/** Query-string parameter carrying a receipt link token. */
export const RECEIPT_LINK_PARAM = "k";

/**
 * Domain separator, and it is load-bearing.
 *
 * `public-access-cookie.ts` signs `String(expMs)` under the SAME AUTH_SECRET.
 * Without a prefix the two signature namespaces overlap, and a value minted for
 * one purpose could be presented for the other — a receipt number that happened
 * to look like a timestamp, or an unlock signature replayed as a link token.
 * Prefixing keeps them provably disjoint.
 */
const DOMAIN = "rl:";

/**
 * Normalize receipt number to uppercase. Matches getTransferByReceiptNumber
 * (src/modules/transfers/transfers.service.ts:110), which looks receipts up
 * case-insensitively, so `/receipts/hr-000123` and `/receipts/HR-000123` render
 * the same page. Without normalization, a link whose path got lowercased anywhere
 * in transit (mail client, QR scanner, manual retyping) would fail the token
 * check and send the recipient to the PIN prompt — the exact failure this token
 * exists to prevent.
 */
function normalizeReceiptNumber(receiptNumber: string): string {
  return receiptNumber.toUpperCase();
}

// Mirror the unlock cookie's convention: __Secure- over HTTPS.
export function receiptGrantCookieName(secure: boolean): string {
  return secure ? "__Secure-pub_receipt" : "pub_receipt";
}

export async function signReceiptLinkToken(receiptNumber: string, secret: string): Promise<string> {
  // Explicit, legible failures. Web Crypto already refuses a zero-length HMAC
  // key with an opaque DOMException from inside importKey; this names the
  // missing variable instead. The blank-receipt guard matters more: signing ""
  // would mint a token that verifies against every request whose path yielded
  // no receipt number.
  if (!secret) throw new Error("AUTH_SECRET is required to sign a receipt link token");
  if (!receiptNumber) throw new Error("a receipt number is required to sign a receipt link token");
  return hmac(secret, DOMAIN + normalizeReceiptNumber(receiptNumber));
}

/** Constant-time check that `token` was minted for exactly `receiptNumber`. */
export async function verifyReceiptLinkToken(
  receiptNumber: string,
  token: string | null | undefined,
  secret: string,
): Promise<boolean> {
  if (!secret || !token || !receiptNumber) return false;
  const expected = await hmac(secret, DOMAIN + normalizeReceiptNumber(receiptNumber));
  return safeEqual(token, expected);
}

/**
 * Cookie value = "<receiptNumber>.<token>" — self-contained, so the proxy can
 * verify it with no lookup, exactly like the unlock cookie. A receipt number
 * contains no dot and a base64url token contains no dot, so the first dot is
 * unambiguously the separator.
 */
export function receiptGrantValue(receiptNumber: string, token: string): string {
  return `${receiptNumber}.${token}`;
}

/**
 * Check a grant cookie against the receipt the CALLER is asking for.
 *
 * The receipt number inside the cookie is never trusted on its own: it must
 * both match the requested one and be the number the signature covers. So
 * rewriting the name in the cookie invalidates it rather than widening it.
 */
export async function verifyReceiptGrantValue(
  value: string | undefined,
  receiptNumber: string,
  secret: string,
): Promise<boolean> {
  if (!value || !receiptNumber) return false;
  const dot = value.indexOf(".");
  if (dot <= 0) return false;
  const named = value.slice(0, dot);
  const token = value.slice(dot + 1);
  if (!token || normalizeReceiptNumber(named) !== normalizeReceiptNumber(receiptNumber)) return false;
  return verifyReceiptLinkToken(named, token, secret);
}
