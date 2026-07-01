CREATE UNIQUE INDEX "one_pending_transfer_per_item"
ON "Transfer" ("itemId")
WHERE "status" = 'PENDING';
