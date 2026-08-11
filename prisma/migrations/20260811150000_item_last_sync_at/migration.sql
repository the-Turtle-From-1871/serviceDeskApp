-- The parsed twin of "lastSyncDateTime": when MDM last CHECKED IN with the
-- device, as an instant.
--
-- The sync column shipped 2026-08-10 as raw text and deliberately without a
-- twin, because nothing computed over it. The dormant-device chase list now
-- does: it moved from "nobody has SIGNED IN for 30-90 days" (lastLogonAt) to
-- "MDM has not SEEN the device for 30-90 days", and it buckets ~1,200 items in
-- SQL. Raw text cannot answer that — a string comparison puts '10/1/2025' ahead
-- of '7/25/2026'.
--
-- Nullable and additive, so this is safe to apply before the code that reads it
-- deploys. Indexed because the window is a range scan run on every dashboard
-- load; a plain B-tree, matching "Item_lastLogonAt_idx", since the column is
-- mostly null today.

-- AlterTable
ALTER TABLE "Item" ADD COLUMN     "lastSyncAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Item_lastSyncAt_idx" ON "Item"("lastSyncAt");

-- Best-effort backfill, deliberately identical in shape to the lastLogonAt
-- backfill in 20260728000000_derive_readiness.
--
-- ONLY the exact shape the MDM export is known to emit ('M/D/YYYY h:mm:ss AM')
-- is converted; anything else is left NULL rather than guessed. The regex guard
-- means to_timestamp never sees a string it cannot parse, so a malformed value
-- cannot abort the migration. The importer parses in TypeScript
-- (parseMdmDateTime, unit-tested) and fills the rest on the next run; this only
-- avoids a fleet-wide empty chase list between the migration and that import.
--
-- Expect this to fill in FEWER rows than the lastLogonAt backfill did: the raw
-- column is one day old, so only devices imported since 2026-08-10 carry a sync
-- string at all. That is the accepted starting state — a device MDM has never
-- reported a sync for is "we cannot say", not "dormant", and the window
-- excludes it either way.
UPDATE "Item"
SET "lastSyncAt" = to_timestamp(btrim("lastSyncDateTime"), 'FMMM/FMDD/YYYY FMHH12:MI:SS AM')
WHERE "lastSyncDateTime" IS NOT NULL
  AND btrim("lastSyncDateTime") ~ '^\d{1,2}/\d{1,2}/\d{4} \d{1,2}:\d{2}:\d{2} (AM|PM)$';
