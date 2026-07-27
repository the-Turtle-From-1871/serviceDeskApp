import "server-only";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import type { ReadinessState } from "./readiness";
import { READINESS_CASE, READINESS_JOINS } from "./readiness.sql";

/**
 * Derive readiness for a known set of items, in ONE query.
 *
 * WHY SQL AND NOT readinessState() PER ROW: two of the six signals live in
 * other tables (a PENDING ServiceQueueItem, an open unreturned TransferItem).
 * Classifying a page of rows in TypeScript would mean loading those relations
 * per row — the N+1 CLAUDE.md forbids. This embeds the same CASE the dashboard
 * uses, so the list badge, the item page, and the analytics buckets all answer
 * from one derivation (kept in step with the TS twin by readiness.parity.test).
 *
 * BOUNDED BY THE CALLER: `ids` is a page of items (or a single id), never a
 * table scan. Returns a Map so a caller can render rows in its own order; an
 * id that no longer exists is simply absent.
 */
export async function readinessForItems(ids: string[]): Promise<Map<string, ReadinessState>> {
  const wanted = [...new Set(ids.filter((id) => id !== ""))];
  if (wanted.length === 0) return new Map();

  // Ids are bound as parameters via Prisma.join — never spliced into the SQL.
  const rows = await prisma.$queryRaw<{ id: string; readiness: ReadinessState }[]>(Prisma.sql`
    SELECT i."id" AS id, ${READINESS_CASE} AS readiness
    FROM "Item" i
    ${READINESS_JOINS}
    WHERE i."id" IN (${Prisma.join(wanted)})
  `);
  return new Map(rows.map((r) => [r.id, r.readiness]));
}

/** Single-item convenience. Falls back to UNTRIAGED — the "we have heard
 *  nothing about this device" state — rather than throwing, so a page can
 *  still render if the row vanished between fetches. */
export async function readinessForItem(id: string): Promise<ReadinessState> {
  return (await readinessForItems([id])).get(id) ?? "UNTRIAGED";
}
