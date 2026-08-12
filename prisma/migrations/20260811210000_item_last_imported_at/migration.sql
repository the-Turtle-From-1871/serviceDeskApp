-- When an MDM import last CARRIED this device's serial.
--
-- Stamped on every row an import touched — created, updated, AND unchanged —
-- because "the file still lists this device" is true of all three, and the
-- unchanged rows are precisely the ones a naive implementation forgets.
--
-- WHAT IT IS FOR: a device absent from the export leaves no trace anywhere by
-- definition, so nothing in the database could previously tell "MDM stopped
-- reporting this" from "MDM reported it and it has not synced lately". The
-- dropped-off-network list derives both the state and the DATE it happened from
-- this column against the ImportBatch history; neither is stored, so a device
-- that reappears in a later export un-flags itself with no cleanup.
--
-- Nullable and additive, so this is safe to apply before the code that writes
-- it deploys. NO BACKFILL, deliberately: the only honest value for a device
-- nobody has stamped yet is "unknown", and NULL is read as "no import has ever
-- carried this serial" — which suppresses the dropped-off flag entirely until
-- one has. That is what makes the feature self-arming rather than declaring the
-- whole fleet missing on the first run.

-- AlterTable
ALTER TABLE "Item" ADD COLUMN     "lastImportedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Item_lastImportedAt_idx" ON "Item"("lastImportedAt");

-- The census lookups ask this table two questions on every dashboard load —
-- "when was the newest fleet census?" and "which was the first census after
-- this device was last seen?" — and both filter on a non-null sourceHash
-- ordered by time.
-- CreateIndex
CREATE INDEX "ImportBatch_sourceHash_createdAt_idx" ON "ImportBatch"("sourceHash", "createdAt");
