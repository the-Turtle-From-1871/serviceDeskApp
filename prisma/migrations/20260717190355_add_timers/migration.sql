ALTER TABLE "Transfer" ADD COLUMN "dueAt" TIMESTAMP(3);
ALTER TABLE "Transfer" ADD COLUMN "overdueAlertedAt" TIMESTAMP(3);
ALTER TABLE "ServiceQueueItem" ADD COLUMN "dueAt" TIMESTAMP(3);
ALTER TABLE "ServiceQueueItem" ADD COLUMN "overdueAlertedAt" TIMESTAMP(3);
CREATE INDEX "Transfer_dueAt_idx" ON "Transfer"("dueAt");
CREATE INDEX "ServiceQueueItem_dueAt_idx" ON "ServiceQueueItem"("dueAt");
