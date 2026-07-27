import "server-only";
import { Prisma } from "@prisma/client";

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

/** `WHERE` fragment applying the dashboard's UIC filter. Lifecycle-retired
 *  items are NOT excluded here — unlike the other aggregates, readiness has a
 *  RETIRED bucket of its own, so filtering them out would silently empty it. */
export const readinessScope = (uic: string | null) =>
  Prisma.sql`(${uic}::text IS NULL OR i."deviceUIC" = ${uic}::text)`;
