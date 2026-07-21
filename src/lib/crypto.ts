import "server-only";
import { sign, verify, createPublicKey } from "node:crypto";

/** Deterministic JSON: recursively sort object keys so the signed byte string is
 *  reproducible. Arrays keep order — callers pre-sort arrays whose order isn't
 *  already deterministic (see seal.ts item sort). Primitives via JSON.stringify. */
export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Missing key is a config problem the verify path reports as "can't verify". */
export class CryptoKeyUnavailableError extends Error {}

function privateKeyPem(): string | null {
  // Un-escape single-line \n PEMs from .env; no-op on real newlines (Vercel).
  return process.env.SIGNING_PRIVATE_KEY?.replace(/\\n/g, "\n") ?? null;
}

/** Ed25519 seal (base64) over the canonical manifest. Best-effort: returns null
 *  + logs (never the key) if the key is absent or signing throws, so sealing
 *  never blocks a handoff. Ed25519 hashes internally — algorithm arg is null. */
export function generateCryptographicSeal(manifestData: object): string | null {
  const pem = privateKeyPem();
  if (!pem) {
    console.error("[crypto] SIGNING_PRIVATE_KEY unset; storing receipt unsealed.");
    return null;
  }
  try {
    return sign(null, Buffer.from(canonicalize(manifestData), "utf8"), pem).toString("base64");
  } catch (err) {
    console.error("[crypto] seal generation failed; storing receipt unsealed:", err);
    return null;
  }
}

/** Verify a base64 Ed25519 seal against the canonical manifest. The public key is
 *  derived from SIGNING_PRIVATE_KEY (no separate env var). Throws
 *  CryptoKeyUnavailableError when no key is configured; returns false for a
 *  genuine signature mismatch (tamper). */
export function verifyCryptographicSeal(manifestData: object, signatureBase64: string): boolean {
  const pem = privateKeyPem();
  if (!pem) throw new CryptoKeyUnavailableError("SIGNING_PRIVATE_KEY unset");
  const publicKey = createPublicKey(pem);
  return verify(null, Buffer.from(canonicalize(manifestData), "utf8"), publicKey, Buffer.from(signatureBase64, "base64"));
}
