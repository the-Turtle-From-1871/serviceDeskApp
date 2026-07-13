// Absolute deploy origin for building links (emails, QR codes). Prefer an
// explicitly configured APP_URL; fall back to Vercel's injected domain envs.
// Returns "" if none are set (callers must handle the empty case). No trailing
// slash is stripped here — call sites strip as needed.
export function defaultBaseUrl(): string {
  if (process.env.APP_URL) return process.env.APP_URL;
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL;
  return vercel ? `https://${vercel}` : "";
}
