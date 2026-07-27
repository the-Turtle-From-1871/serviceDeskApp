-- Drop the stored accountability flag. Accountability is now DERIVED from audit
-- recency (Item.lastAuditedAt, maintained by recordAudit) rather than stored.
--
-- WHY THIS LOSES NOTHING: `isAccountedFor` was `BOOLEAN NOT NULL DEFAULT true`
-- and only one admin bulk action ever wrote it. At the time of this migration
-- production held 1,139 items and ZERO rows with `isAccountedFor = false` — every
-- value in the column was the default. It therefore carried no observation about
-- any device, while reporting a 100%-accounted-for fleet of which only 4 items
-- had ever actually been audited.
--
-- DESTRUCTIVE and one-way: re-adding the column would restore the default, not
-- the data. That is acceptable here precisely because the data was all default.
-- The corresponding ItemStatusHistory column is dropped for the same reason; the
-- status timeline reads only deployableStatus, so no chart loses a series.

-- AlterTable
ALTER TABLE "Item" DROP COLUMN "isAccountedFor";

-- AlterTable
ALTER TABLE "ItemStatusHistory" DROP COLUMN "isAccountedFor";
