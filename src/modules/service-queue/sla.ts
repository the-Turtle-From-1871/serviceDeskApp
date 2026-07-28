import { computeDueAt } from "@/modules/timers/due";

/**
 * The completion deadline for a service item: `from` + `days`, or **null when no
 * days were given**.
 *
 * A blank (or malformed — see `parseOverrideDays`) SLA value means "no
 * deadline", NOT a per-type default. There used to be an `SLA_DAYS` table here
 * that silently substituted 3/7/5 days whenever the field was left empty; it was
 * removed because a deadline nobody set is a deadline nobody agreed to — it
 * surfaced as an overdue email and an "Overdue Nd" badge for work that never had
 * a due date. Same principle as readiness/accountability: only claim what a real
 * signal asserts. If a default is ever wanted again it must be a VISIBLE prefill
 * in the flag UI that the user can clear back to blank, never an invisible
 * server-side substitution.
 *
 * `null` is storable as-is: `ServiceQueueItem.dueAt` is already nullable, and
 * every consumer (the queue's Due column, the dashboard timer lists, the overdue
 * sweep) already filters or renders null as "no timer".
 */
export function computeServiceDueAt(from: Date, days?: number | null): Date | null {
  return days != null ? computeDueAt(from, days) : null;
}

/**
 * The deadline fields an **UPDATE** of an existing service row should carry for
 * an optional day count.
 *
 * - a day count → a fresh `dueAt` of `from + days`, and `overdueAlertedAt`
 *   re-armed so the new deadline can alert on its own merits;
 * - **absent (blank/malformed) → an EMPTY object: leave the stored deadline
 *   completely alone.** `dueAt` never reaches the SQL, so the stored instant is
 *   not recomputed, not rounded to a day, and not re-based on "now" — a re-save
 *   that changes only the service type or note cannot move it by so much as a
 *   millisecond, however many times it is saved.
 *
 * The stored value is an absolute deadline while the input is *days from now*,
 * so those two units can never round-trip: prefilling "days remaining" and
 * saving unchanged would push the deadline out by the days remaining, again on
 * every save. Not writing the column at all is the only representation that is
 * exactly stable, so that is the one used.
 *
 * **CLEARING is deliberately NOT expressible here.** Blank means "no change",
 * not "no deadline", so no ordinary save can wipe a deadline nobody touched.
 * Clearing lives in `setServiceDeadline`, behind its own single-purpose control
 * — mirroring the hand-receipt return timer, where `setReceiptDueAtAction` /
 * `ReceiptDueAtControls` are likewise the one form whose blank clears and the
 * receipt's other edits never touch `Transfer.dueAt`.
 *
 * Creation is different and stays with `computeServiceDueAt`: a row that does
 * not exist yet has no deadline to preserve, so blank there means `dueAt = null`.
 */
export function serviceDueAtUpdate(
  days: number | null | undefined,
  from: Date = new Date(),
): { dueAt?: Date; overdueAlertedAt?: null } {
  return days != null ? { dueAt: computeDueAt(from, days), overdueAlertedAt: null } : {};
}
