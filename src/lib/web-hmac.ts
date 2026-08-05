// Zero imports; uses only Web Crypto globals (crypto.subtle, btoa, TextEncoder),
// so it is safe to import from anywhere — the src/proxy.ts proxy (Node runtime
// in Next 16) and Node server actions alike.
// Web Crypto only — do NOT import bcrypt, Prisma, node:crypto, or server-only here.
//
// Extracted from public-access-cookie.ts when receipt-link-token.ts needed the
// same three primitives. They are shared rather than copied on purpose: two
// constant-time compares drift, and the one that drifts stops being
// constant-time silently.

export function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function hmac(secret: string, msg: string): Promise<string> {
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
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
