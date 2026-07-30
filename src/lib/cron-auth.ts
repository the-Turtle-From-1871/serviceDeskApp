import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time `Authorization: Bearer <secret>` check for routes that have no
 * user session — cron sweeps and machine-driven imports.
 *
 * FAILS CLOSED when the expected secret is unset or blank: a missing env var is
 * a misconfiguration, and treating it as "no auth required" would silently open
 * the endpoint on any environment that forgot to set it.
 *
 * Compares the WHOLE header (including the `Bearer ` prefix) so a caller cannot
 * pass the bare secret, and length-checks first because timingSafeEqual throws
 * on differing lengths. The length of a rejected guess leaks, which is not a
 * useful oracle against a random secret.
 *
 * No `server-only`, no Prisma: this must stay importable from anywhere.
 */
export function hasValidBearerSecret(req: Request, secret: string | undefined): boolean {
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
