/**
 * How a dormant-device row is coloured in the exported sheet.
 *
 * Pure — no xlsx library, no Prisma — so the rule that decides what a technician
 * sees is unit-testable on its own, the same reason `readiness.ts` and
 * `audit.status.ts` are split out from the code that stores their inputs.
 */

import { STALE_MIN_DAYS, STALE_MAX_DAYS } from "./analytics.types";

export type StaleSeverity = "noncompliant" | "older" | "recent";

/**
 * The day at which a row goes from yellow to orange.
 *
 * Sits halfway through the 30-90 window rather than at a round 60 by accident:
 * it is derived so that widening the window in `analytics.types.ts` cannot leave
 * a band boundary stranded outside it. With today's 30/90 it IS 60, which is
 * what was asked for.
 */
export const STALE_ESCALATE_DAYS = (STALE_MIN_DAYS + STALE_MAX_DAYS) / 2;

/**
 * The compliance values that count as NOT compliant.
 *
 * `Item.compliance` is free text copied verbatim from the MDM export, so this
 * matches on a normalized (trimmed, lowercased) value rather than assuming
 * Intune's exact casing. Measured on the live fleet: `compliant` 859,
 * `noncompliant` 180, `inGracePeriod` 13, blank 156.
 *
 * `inGracePeriod` is deliberately NOT red. Grace is Intune saying "out of policy
 * but not yet enforced" — the device is still compliant as far as access is
 * concerned, and colouring it the same as a genuinely blocked device would
 * overstate it. Exactly one device in the current window is in grace, so this is
 * a small call, but it is a call: flip this set if the desk wants grace chased.
 *
 * A BLANK compliance is not red either. Blank means the export said nothing
 * about the device, which is "we cannot say" — the same reasoning that keeps a
 * device with no sync time off the list entirely rather than on it as urgent.
 */
const NONCOMPLIANT = new Set(["noncompliant", "non-compliant", "not compliant"]);

export function isNoncompliant(compliance: string | null | undefined): boolean {
  return NONCOMPLIANT.has((compliance ?? "").trim().toLowerCase());
}

/**
 * Severity for one row, highest first.
 *
 * NON-COMPLIANCE OUTRANKS AGE, by explicit decision (2026-08-11). The known
 * consequence, measured on the fleet the day it was chosen: **82 of the 86
 * devices in the window are non-compliant**, so the sheet is overwhelmingly red
 * and the yellow/orange banding shows on the remaining four. That was accepted
 * knowingly — a device out of compliance is the one to pick up first regardless
 * of how long MDM has been quiet. If the banding is ever wanted back, the fix is
 * NOT to reorder these branches silently: it is to give compliance its own
 * column and let age keep the row, which is the alternative that was weighed.
 *
 * `days` is whole days since the last sync, matching the "Days since sync"
 * column, so the colour and the number can never disagree about the same row.
 */
export function staleSeverity(days: number, compliance: string | null | undefined): StaleSeverity {
  if (isNoncompliant(compliance)) return "noncompliant";
  return days >= STALE_ESCALATE_DAYS ? "older" : "recent";
}

/**
 * Fill colours, as `aarrggbb`-free 6-digit hex (what write-excel-file takes).
 *
 * Chosen to survive being printed in greyscale and read by someone with a
 * red-green deficiency: the three fills differ in LIGHTNESS as well as hue
 * (≈93%, ≈85%, ≈78% relative luminance descending), so the ordering is legible
 * even when the hue is not. They are pale on purpose — a saturated fill behind
 * black spreadsheet text drops contrast below readable, and every one of these
 * keeps black text above 7:1.
 *
 * NOT taken from the analytics chart palette: that one is tuned for adjacent
 * chart wedges on the ledger surface (`palette.ts`), and Excel renders on white
 * with its own gridlines.
 */
export const SEVERITY_FILL: Record<StaleSeverity, string> = {
  noncompliant: "#F8CBCB", // red
  older: "#FBD9A5", // orange
  recent: "#FCF0B4", // yellow
};

/** What the sheet's legend calls each band. */
export function severityLabel(severity: StaleSeverity): string {
  switch (severity) {
    case "noncompliant":
      return "Not compliant";
    case "older":
      return `${STALE_ESCALATE_DAYS}–${STALE_MAX_DAYS} days since sync`;
    case "recent":
      return `${STALE_MIN_DAYS}–${STALE_ESCALATE_DAYS - 1} days since sync`;
  }
}
