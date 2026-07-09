// Shared validation for drawn signatures (PNG data URLs). Pure — used by the
// account action and the return action to gate/persist a signature server-side.
export const MAX_SIGNATURE_LEN = 250_000;

export function signatureError(s: string): string | null {
  if (!s) return "A signature is required.";
  if (!s.startsWith("data:image/png;base64,")) return "Invalid signature format.";
  if (s.length > MAX_SIGNATURE_LEN) return "Signature image is too large.";
  return null;
}
