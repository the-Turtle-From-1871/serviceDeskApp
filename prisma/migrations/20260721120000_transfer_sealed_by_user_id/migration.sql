-- Immutable acting-user snapshot for the handoff seal. The createdByUser FK is
-- ON DELETE SET NULL; the seal must bind a value deletion can't null. Nullable,
-- additive, no backfill.
ALTER TABLE "Transfer" ADD COLUMN "sealedByUserId" TEXT;
