-- CreateIndex
CREATE INDEX "Transfer_receiverName_trgm_idx" ON "Transfer" USING GIN ("receiverName" gin_trgm_ops);
