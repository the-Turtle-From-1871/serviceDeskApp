// Pure staleness math for the "last import" signal on /admin/units. No
// Prisma/`server-only`/React here so it is unit-testable and safe in client
// bundles — mirrors src/modules/timers/due.ts's dueState(dueAt, now).
const HOUR_MS = 60 * 60 * 1000;

// A dead scheduled job and a fleet that has genuinely stopped changing look
// identical from the app's point of view — no error is thrown, just silence.
// 48h gives the nightly import a couple of missed runs of slack before
// flagging it, rather than firing on the very first delay.
export const STALE_IMPORT_HOURS = 48;

/**
 * Has the fleet gone too long without an import?
 *
 * `now` is an explicit parameter (not read internally via `Date.now()`) so
 * this stays pure and testable, and so the one call site (the Server
 * Component page) supplies the real request-time clock itself — see
 * page.tsx for why that boundary matters (both the eslint-plugin-react-hooks
 * purity rule and avoiding a client-side clock read).
 *
 * `null` (no import has ever run) is NOT stale by this function's contract —
 * that is a distinct state the caller renders as "No import has run yet."
 * rather than as a staleness warning.
 *
 * Strictly-greater-than: exactly 48h old is NOT yet stale, only just over is.
 * A future-dated `lastImportAt` (clock skew) is never stale — the diff goes
 * negative, which is <= the threshold.
 */
export function isImportStale(lastImportAt: Date | null, now: Date): boolean {
  if (!lastImportAt) return false;
  return now.getTime() - lastImportAt.getTime() > STALE_IMPORT_HOURS * HOUR_MS;
}
