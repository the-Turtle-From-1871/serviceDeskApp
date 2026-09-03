import { STALE_MIN_DAYS } from "@/app/admin/analytics/analytics.types";

/**
 * The "has not checked in" window used by the /items filter and the
 * dormant-device notification.
 *
 * THE THRESHOLD IS NOT DEFINED HERE. It is `STALE_MIN_DAYS`, the same 30 the
 * analytics dormant-device sheet already uses — imported rather than restated,
 * because two copies of that number are two answers to "when is a device
 * dormant" and they would drift the first time one is tuned. (analytics.types
 * is deliberately free of `server-only` and Prisma, so a pure leaf may import
 * it; that file says so in its own header.)
 *
 * WHAT IS DIFFERENT HERE, and it is deliberate: the analytics sheet is a
 * half-open 30-90 day window, because past 90 days is long-term lost kit — a
 * different problem that would bury the devices still worth chasing. This
 * filter has NO UPPER BOUND. It answers a different question: a device unseen
 * for 200 days is not less worth telling its holder about, it is more. Do not
 * "align" the two by adding STALE_MAX_DAYS here; the divergence is the point.
 */

export { STALE_MIN_DAYS as STALE_SYNC_DAYS } from "@/app/admin/analytics/analytics.types";

/** The instant a device must have synced AFTER to count as current. `now` is
 *  injected rather than read inside the query, so the filter, the count and the
 *  notification all describe the same moment. */
export function staleSyncCutoff(now: Date): Date {
  return new Date(now.getTime() - STALE_MIN_DAYS * 24 * 60 * 60 * 1000);
}
