-- Trigram (pg_trgm) GIN indexes so the public, per-keystroke `ILIKE '%q%'` searches
-- can use an index instead of a full table scan: serial search (searchItemsBySerial)
-- and receipt-number search (searchReceiptsByNumber). A leading wildcard can't use a
-- B-tree, which is why the existing unique indexes don't help these.
-- gin_trgm_ops works directly on citext (Item.serialNumber) — citext is
-- binary-coercible to text.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateIndex
CREATE INDEX "Item_serialNumber_trgm_idx" ON "Item" USING GIN ("serialNumber" gin_trgm_ops);
-- CreateIndex
CREATE INDEX "Transfer_receiptNumber_trgm_idx" ON "Transfer" USING GIN ("receiptNumber" gin_trgm_ops);
