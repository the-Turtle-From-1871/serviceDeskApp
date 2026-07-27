// Pure readiness logic. Kept free of Prisma/React so it is unit-testable
// (mirrors audit.status.ts and service-queue.status.ts).
//
// Readiness is DERIVED, never stored. The one thing an operator sets by hand is
// `markedReadyAt` — "this is back on my shelf" — and even that is outranked by
// evidence that the device has been used since.
//
// WHY DERIVED: the previous design stored a four-value `deployableStatus` enum
// set only from a bulk action. In production 0 of 1,139 items ever had it set,
// so every device read "Untriaged" — the column measured a default, not the
// fleet. The same lesson that retired the stored accounted-for flag.

export type ReadinessState =
  | "RETIRED"
  | "IN_REPAIR"
  | "DEPLOYED"
  | "READY_TO_DEPLOY"
  | "UNTRIAGED";

/** Display order: worst-to-best operationally, with untriaged last. Also the
 *  order the analytics chart stacks its series in. */
export const READINESS_ORDER: readonly ReadinessState[] = [
  "DEPLOYED",
  "READY_TO_DEPLOY",
  "IN_REPAIR",
  "RETIRED",
  "UNTRIAGED",
] as const;

export const READINESS_LABEL: Record<ReadinessState, string> = {
  DEPLOYED: "Deployed",
  READY_TO_DEPLOY: "Ready to deploy",
  IN_REPAIR: "In repair",
  RETIRED: "Retired",
  UNTRIAGED: "Untriaged",
};

/** The signals readiness is computed from. Every field is something the app
 *  already records for its own reasons — none exist solely to feed this. */
export type ReadinessSignals = {
  /** Item lifecycle status, not a readiness state. */
  status: "ACTIVE" | "RETIRED";
  /** True when the item has a PENDING ServiceQueueItem. */
  flaggedForService: boolean;
  /** True when the item sits on an OPEN hand receipt with an unreturned line. */
  onOpenReceipt: boolean;
  /** Parsed MDM last-logon instant (see parseLastLogonAt). Null when the raw
   *  string was absent or unparseable. */
  lastLogonAt: Date | null;
  /** Raw MDM last-logon user. Present = the device has been used by someone,
   *  even if the date could not be parsed. */
  lastLogonUser: string | null;
  /** When an operator last marked the device back in our possession. */
  markedReadyAt: Date | null;
};

/**
 * Derive an item's readiness.
 *
 * PRECEDENCE IS THE DESIGN — the order below is load-bearing, not incidental:
 *
 *  1. RETIRED     — lifecycle beats everything; a retired device has no readiness.
 *  2. IN_REPAIR   — a service flag outranks any "deployed" signal. This is the
 *                   case that made an earlier rule forbid inferring DEPLOYED
 *                   from receipts at all: a device turned in for repair while
 *                   its receipt is still open must NOT read Deployed. Checking
 *                   service first is what makes the receipt rule below safe.
 *  3. DEPLOYED    — on an open, unreturned hand receipt. Reflects an issue the
 *                   moment it happens, with no wait for the next MDM import.
 *  4. DEPLOYED    — used since it was shelved (lastLogonAt > markedReadyAt).
 *                   This is why markedReadyAt is a TIMESTAMP and not a boolean:
 *                   the marking self-expires instead of going stale.
 *  5. READY       — marked on hand, and nothing above contradicts it.
 *  6. DEPLOYED    — has an MDM last-logon user. Covers the ~1,053 devices that
 *                   are genuinely in soldiers' hands but predate the app, so
 *                   have no hand receipt. Deliberately LAST of the deployed
 *                   rules: it is the weakest evidence and the stickiest.
 *  7. UNTRIAGED   — no signal at all. Not a failure state; it means "we have
 *                   never heard anything about this device".
 */
export function readinessState(s: ReadinessSignals): ReadinessState {
  if (s.status === "RETIRED") return "RETIRED";
  if (s.flaggedForService) return "IN_REPAIR";
  if (s.onOpenReceipt) return "DEPLOYED";
  if (s.lastLogonAt && s.markedReadyAt && s.lastLogonAt > s.markedReadyAt) return "DEPLOYED";
  if (s.markedReadyAt) return "READY_TO_DEPLOY";
  if (s.lastLogonUser && s.lastLogonUser.trim() !== "") return "DEPLOYED";
  return "UNTRIAGED";
}

/**
 * Parse the MDM export's free-text last-logon into an instant.
 *
 * `Item.lastLogonDate` is stored verbatim as text ("7/25/2026 1:40:21 AM")
 * because the export's format is not ours to guarantee. Readiness needs to
 * COMPARE it to markedReadyAt, and the dashboard needs to do that across the
 * whole fleet in SQL — so the parse happens once, here, on import, into the
 * denormalized `lastLogonAt` column. Parsing in Postgres instead would abort a
 * whole import on the first unexpected format.
 *
 * Returns null rather than throwing on anything unrecognised: an unparseable
 * date must degrade to "we don't know when", never fail the import. The raw
 * string is always kept for display.
 */
export function parseLastLogonAt(raw: string | null | undefined): Date | null {
  const text = (raw ?? "").trim();
  if (!text) return null;

  // M/D/YYYY h:mm:ss AM/PM — the observed MDM shape. Parsed explicitly rather
  // than left to `new Date()`, whose handling of ambiguous formats varies by
  // runtime and locale.
  const us = text.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/,
  );
  if (us) {
    const [, mo, day, yr, hh, mi, ss, mer] = us;
    let hour = hh ? Number(hh) : 0;
    if (mer) {
      const pm = mer.toLowerCase() === "pm";
      if (hour === 12) hour = pm ? 12 : 0;
      else if (pm) hour += 12;
    }
    const d = new Date(Date.UTC(Number(yr), Number(mo) - 1, Number(day), hour, Number(mi ?? 0), Number(ss ?? 0)));
    // Reject impossible dates that Date.UTC silently rolls over (2/30 -> 3/2).
    if (d.getUTCMonth() !== Number(mo) - 1 || d.getUTCDate() !== Number(day)) return null;
    return d;
  }

  // ISO-8601 and other unambiguous forms.
  const iso = new Date(text);
  return Number.isNaN(iso.getTime()) ? null : iso;
}
