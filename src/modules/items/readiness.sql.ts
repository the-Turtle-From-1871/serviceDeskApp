import "server-only";
import { Prisma } from "@prisma/client";
import { READINESS_ORDER } from "./readiness";

/* ============================================================
   The SQL twin of readinessState() in readiness.ts.

   WHY A SECOND COPY EXISTS: readinessState decides one row in TypeScript,
   which the dashboard cannot use — it buckets 1,100+ items and must do so in
   the database. Rather than let each surface invent its own rule, both are
   written once here and there, and `readiness.parity.test.ts` runs the SAME
   fixture table through BOTH and asserts they agree. If you change the
   precedence in one, that test fails until you change the other.

   The precedence below is load-bearing and is documented in full on
   readinessState(); the short version is that a service flag outranks every
   "deployed" signal, which is what makes the open-receipt rule safe.
   ============================================================ */

/** Alias the caller must use for the Item table when embedding these. */
export const ITEM_ALIAS = "i";

/**
 * Joins the derivation needs. Kept separate from the CASE so a query can put
 * them in the right place in its own FROM clause.
 *
 * - `sq`: the item's PENDING service-queue row, if any. ServiceQueueItem is
 *   unique per item, so this cannot fan out.
 * - the open-receipt test is an EXISTS rather than a join, so an item on two
 *   receipts still counts once.
 */
export const READINESS_JOINS = Prisma.sql`
  LEFT JOIN "ServiceQueueItem" sq
    ON sq."itemId" = i."id" AND sq."status" = 'PENDING'
`;

/** SQL expression yielding the same strings as ReadinessState. */
export const READINESS_CASE = Prisma.sql`
  CASE
    WHEN i."status" = 'RETIRED' THEN 'RETIRED'
    WHEN sq."itemId" IS NOT NULL THEN 'IN_REPAIR'
    WHEN EXISTS (
      SELECT 1
      FROM "TransferItem" ti
      JOIN "TransferLine" tl ON tl."id" = ti."transferLineId"
      JOIN "Transfer" t ON t."id" = tl."transferId"
      WHERE ti."itemId" = i."id"
        AND ti."returnedAt" IS NULL
        AND t."status" = 'OPEN'
    ) THEN 'DEPLOYED'
    WHEN i."lastLogonAt" IS NOT NULL
     AND i."markedReadyAt" IS NOT NULL
     AND i."lastLogonAt" > i."markedReadyAt" THEN 'DEPLOYED'
    WHEN i."markedReadyAt" IS NOT NULL THEN 'READY_TO_DEPLOY'
    WHEN i."lastLogonUserPrincipalName" IS NOT NULL
     AND btrim(i."lastLogonUserPrincipalName") <> '' THEN 'DEPLOYED'
    ELSE 'UNTRIAGED'
  END
`;

/**
 * READINESS_CASE as an integer, so a query can ORDER BY readiness.
 *
 * WHY A RANK AND NOT THE TEXT: sorting the CASE's own strings would order them
 * alphabetically — 'DEPLOYED', 'IN_REPAIR', 'READY_TO_DEPLOY', 'RETIRED',
 * 'UNTRIAGED' — which reads as nonsense to an operator and puts "Deployed" and
 * "Ready to deploy" (the two states people compare) at opposite ends of the
 * list. The rank is built FROM `READINESS_ORDER`, the same worst-to-best,
 * untriaged-last sequence the analytics chart stacks and the docs describe, so
 * an ascending `/items` sort walks the states in the order the rest of the UI
 * already presents them. Adding a state to the enum and to READINESS_ORDER is
 * all it takes; there is no second list here to forget.
 *
 * There is deliberately no ELSE: a state missing from READINESS_ORDER must not
 * be quietly ranked last, it must be noticed. `readiness.test.ts` asserts the
 * order lists every ReadinessState, so the gap fails a test rather than sorting
 * a whole bucket to the end of the table.
 *
 * State names and ranks are BOUND parameters, never interpolated (CLAUDE.md §2).
 */
export const READINESS_RANK = Prisma.sql`(CASE ${READINESS_CASE} ${Prisma.join(
  READINESS_ORDER.map((state, rank) => Prisma.sql`WHEN ${state}::text THEN ${rank}::int`),
  " ",
)} END)`;

/**
 * `WHERE` fragment applying the dashboard's global unit scope, over the `i`
 * alias. The raw-SQL twin of `itemWhere()` in analytics.service.ts, so the
 * aggregates that must run as `$queryRaw` filter identically to the Prisma ones.
 *
 * Both dimensions are optional and compose with AND — the unit-allocation table
 * can group by either `homeUnit` or `deviceUIC` (they are not 1:1 in the
 * catalogue), so each has its own param. A null passes everything through.
 * Values are BOUND, never interpolated (CLAUDE.md §2).
 *
 * Lifecycle-retired items are NOT excluded here — unlike the other aggregates,
 * readiness has a RETIRED bucket of its own, so filtering them out would
 * silently empty it.
 */
export const itemScopeSql = (scope: { uic: string | null; unit: string | null }) =>
  Prisma.sql`(${scope.uic}::text IS NULL OR i."deviceUIC" = ${scope.uic}::text)
      AND (${scope.unit}::text IS NULL OR i."homeUnit" = ${scope.unit}::text)`;
