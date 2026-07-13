import type { Transfer } from "@prisma/client";
import { TransferError } from "./transfers.errors";

// A closed receipt (ticket) is purged exactly this many days after it closes.
export const PURGE_WINDOW_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Expiration timestamp for a closed receipt: exactly 90 days after `closedAt`. */
export function computePurgeAfter(closedAt: Date): Date {
  return new Date(closedAt.getTime() + PURGE_WINDOW_DAYS * DAY_MS);
}

/** A receipt is closed (and therefore immutable) once its status is CLOSED or it
 *  carries a `closedAt` stamp. Either alone is sufficient. */
export function isTransferClosed(t: Pick<Transfer, "status" | "closedAt">): boolean {
  return t.status === "CLOSED" || t.closedAt !== null;
}

/** Immutability guard: throw if the receipt is already closed. Callers that mutate
 *  a Transfer must run this first so a CLOSED ticket can never be reopened, edited,
 *  or modified. */
export function assertTransferOpen(t: Pick<Transfer, "status" | "closedAt">): void {
  if (isTransferClosed(t)) throw new TransferError("CLOSED");
}

/** True when a purge-eligible timestamp has arrived. `purgeAfter` is null for
 *  still-open receipts, which are never eligible. */
export function isPurgeEligible(t: Pick<Transfer, "purgeAfter">, now: Date = new Date()): boolean {
  return t.purgeAfter !== null && t.purgeAfter.getTime() <= now.getTime();
}
