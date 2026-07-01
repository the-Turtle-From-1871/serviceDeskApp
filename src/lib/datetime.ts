// All user-facing dates/times are shown in Hawaii Standard Time (UTC−10, no DST).
// Timestamps are still stored in UTC in the database; this only affects display.
const HST = "Pacific/Honolulu";

/** Date + time in HST, e.g. "Jul 01, 2026, 03:15 PM HST". */
export function formatDateTimeHST(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const s = new Intl.DateTimeFormat("en-US", {
    timeZone: HST,
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(d));
  return `${s} HST`;
}

/** Date only in HST as YYYY-MM-DD (used on the DA 2062 form). */
export function formatDateHST(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: HST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(d));
}
