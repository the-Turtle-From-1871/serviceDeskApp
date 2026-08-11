-- Pool stock: a device kept to lend out temporarily, over and over.
--
-- A new column rather than a reused one, deliberately. deviceCategory, homeUnit
-- and storageLocation are all IMPORTABLE, so the nightly Drive import would
-- revert the mark within a day — "a control that quietly undoes itself is worse
-- than no control". The importer writes a named column set and this is not in
-- it, so it survives every import.
--
-- NOT NULL with a default and no backfill: every existing device is not a
-- loaner, which is a complete and correct answer. A nullable third state would
-- mean "nobody has said", which nothing in this feature reads.
--
-- Additive, so it is safe to apply BEFORE the code that reads it deploys — and
-- it must be, per migrate-before-push: Prisma enumerates every column in its
-- SELECT, so until this exists every item read fails, not just the new control.

-- AlterTable
ALTER TABLE "Item" ADD COLUMN     "isLoaner" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Item_isLoaner_idx" ON "Item"("isLoaner");
