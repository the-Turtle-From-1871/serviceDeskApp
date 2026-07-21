-- Cryptographically sealed asset handoff: store the Ed25519 seal and the exact
-- signed timestamp on each receipt. Both nullable + additive (no backfill),
-- safe to apply online. No index (neither column is filtered or sorted on).
ALTER TABLE "Transfer" ADD COLUMN "cryptoSignature" TEXT;
ALTER TABLE "Transfer" ADD COLUMN "sealedAt" TIMESTAMP(3);
