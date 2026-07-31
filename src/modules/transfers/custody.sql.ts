import "server-only";
import { Prisma } from "@prisma/client";

/* ============================================================
   THE one SQL definition of "this item is in someone's custody right now".

   WHY IT LIVES HERE AND NOT INLINE: this predicate is read by three different
   queries that answer three different questions — is the device deployed
   (READINESS_CASE in items/readiness.sql.ts), does it match a recipient search
   (recipientMatchSql in items/items.service.ts), and who is holding it
   (holdersForItems in ./holders.query.ts). Written out three times, changing
   the rule in one place would silently leave the other two answering the old
   question, with no failing test: the existing parity tests bind the TS/SQL
   readiness twins and the Prisma/raw filter paths, and neither of them can see
   a third copy drift. One fragment is what makes them agree by construction.

   NOTE the deliberate asymmetry with getHoldingTransfer() in
   transfers.service.ts, which takes the LATEST receipt and fails closed. That
   is a stricter rule, kept stricter on purpose because its value prefills a
   signed DA 2062 — naming the wrong holder there is worse than naming none.
   The two can differ when an item sits on an older open receipt and a newer
   closed one. Do not unify them without deciding what the receipt builder
   should get.
   ============================================================ */

/** The join chain from a TransferItem up to its Transfer.
 *
 *  Aliases are FIXED — `ti`, `tl`, `t` — because the predicate below names
 *  them. A caller embedding this must not already use those aliases;
 *  READINESS_JOINS uses `sq` and the Item alias is `i`, so nothing collides.
 *
 *  This is a FROM clause, not a join list: a caller embeds it after its own
 *  `SELECT`, and correlates it to the outer row itself (`ti."itemId" = i."id"`)
 *  — that correlation belongs to the embedding query, not to custody. */
export const CUSTODY_FROM = Prisma.sql`
    FROM "TransferItem" ti
    JOIN "TransferLine" tl ON tl."id" = ti."transferLineId"
    JOIN "Transfer" t ON t."id" = tl."transferId"`;

/** Live custody: this row has not come back, and the receipt is still open.
 *  Both halves are load-bearing — either one alone matches receipts whose
 *  custody has ended: an open receipt can hold rows already returned
 *  (a partial return), and a closed receipt's rows are not all returned rows. */
export const OPEN_CUSTODY_PREDICATE = Prisma.sql`ti."returnedAt" IS NULL AND t."status" = 'OPEN'`;
