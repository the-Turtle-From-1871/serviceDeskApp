import "server-only";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { CUSTODY_FROM, OPEN_CUSTODY_PREDICATE } from "./custody.sql";

/**
 * Who currently holds each of these items, in ONE query.
 *
 * WHY SQL AND NOT A PRISMA INCLUDE PER ROW: custody lives two joins away
 * (Item -> TransferItem -> TransferLine -> Transfer), so resolving it per row is
 * the N+1 CLAUDE.md forbids. Shaped exactly like readinessForItems: bounded by
 * the caller to a page of ids, returns a Map so the caller renders in its own
 * order, and an id with no live custody is simply ABSENT rather than null.
 *
 * THE CUSTODY RULE IS THE SHARED ONE — `custody.sql.ts` is its single
 * definition, embedded here, in READINESS_CASE's DEPLOYED branch and in
 * recipientMatchSql, so the Holder column, the Readiness badge and the /items
 * recipient search cannot contradict each other on the same row. It is NOT
 * getHoldingTransfer's stricter "latest receipt only, fail closed"; the two can
 * differ when an item sits on an older open receipt and a newer closed one, and
 * that asymmetry is deliberate (see custody.sql.ts for why).
 *
 * DISTINCT ON picks the most recent open receipt if an item somehow sits on
 * two, so the column shows one name instead of fanning the row out.
 *
 * Ids are BOUND via Prisma.join, never spliced (CLAUDE.md §2).
 */
export async function holdersForItems(ids: string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id) => id !== ""))];
  if (wanted.length === 0) return new Map();

  const rows = await prisma.$queryRaw<{ itemId: string; receiverName: string }[]>(Prisma.sql`
    SELECT DISTINCT ON (ti."itemId") ti."itemId" AS "itemId", t."receiverName" AS "receiverName"
    ${CUSTODY_FROM}
    WHERE ti."itemId" IN (${Prisma.join(wanted)})
      AND ${OPEN_CUSTODY_PREDICATE}
    ORDER BY ti."itemId", t."createdAt" DESC
  `);
  return new Map(rows.map((r) => [r.itemId, r.receiverName]));
}
