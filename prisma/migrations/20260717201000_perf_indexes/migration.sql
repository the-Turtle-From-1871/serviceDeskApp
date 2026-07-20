-- Performance indexes for the hot sort/filter paths surfaced in the DB audit.
-- All additive (no data change); safe to apply online.

-- /items sorts by createdAt desc on every load.
CREATE INDEX "Item_createdAt_idx" ON "Item"("createdAt");

-- Audit log, receipt-number search, and per-item receipt lists sort by createdAt desc.
CREATE INDEX "Transfer_createdAt_idx" ON "Transfer"("createdAt");

-- Admin dashboard timer sweep: status='OPEN' AND dueAt <= horizon.
CREATE INDEX "Transfer_status_dueAt_idx" ON "Transfer"("status", "dueAt");
