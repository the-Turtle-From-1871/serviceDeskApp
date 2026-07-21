-- Denormalized last-audit timestamp so the /items list can sort by audit status
-- (ORDER BY "lastAuditedAt" nulls last). Additive + nullable; backfilled from the
-- existing ItemAudit rows so the sort is correct from day one.
ALTER TABLE "Item" ADD COLUMN "lastAuditedAt" TIMESTAMP(3);

UPDATE "Item"
SET "lastAuditedAt" = a.max_created
FROM (
  SELECT "itemId", MAX("createdAt") AS max_created
  FROM "ItemAudit"
  GROUP BY "itemId"
) a
WHERE "Item".id = a."itemId";

CREATE INDEX "Item_lastAuditedAt_idx" ON "Item"("lastAuditedAt");
