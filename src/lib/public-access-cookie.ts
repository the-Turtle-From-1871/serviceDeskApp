// Zero imports; uses only Web Crypto globals (crypto.subtle, btoa, TextEncoder),
// so it is safe to import from anywhere — the src/proxy.ts proxy (Node runtime
// in Next 16) and Node server actions alike.
// Web Crypto only — do NOT import bcrypt, Prisma, node:crypto, or server-only here.

export const UNLOCK_MAX_AGE_SECONDS = 7 * 24 * 60 * 60; // 7 days
export const UNLOCK_TTL_MS = UNLOCK_MAX_AGE_SECONDS * 1000;

// Mirror Auth.js's cookie-prefix convention: __Secure- over HTTPS.
export function unlockCookieName(secure: boolean): string {
  return secure ? "__Secure-pub_unlock" : "pub_unlock";
}

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(secret: string, msg: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return base64url(new Uint8Array(sig));
}

// Length-checked constant-time string compare (avoids early-exit timing leak).
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

// Cookie value = "<expMs>.<hmac(secret, expMs)>". Self-contained so the edge
// proxy can verify it with no DB lookup.
export async function signUnlockValue(expMs: number, secret: string): Promise<string> {
  const sig = await hmac(secret, String(expMs));
  return `${expMs}.${sig}`;
}

export async function verifyUnlockValue(
  value: string | undefined,
  secret: string,
  nowMs: number,
): Promise<boolean> {
  if (!value) return false;
  const dot = value.indexOf(".");
  if (dot <= 0) return false;
  const expStr = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (!sig) return false;
  const expMs = Number(expStr);
  if (!Number.isFinite(expMs) || expMs <= nowMs) return false;
  const expected = await hmac(secret, expStr);
  return safeEqual(sig, expected);
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
