-- Readiness becomes a DERIVED value. See modules/items/readiness.ts.
--
-- DESTRUCTIVE AND ONE-WAY. What is lost, and why that is acceptable:
--
--   Item."deployableStatus"  — a 4-value enum written only by a bulk admin
--     action. Production held 1,139 items with ZERO non-null values, so every
--     device read "Untriaged": the column reported its own default, never the
--     fleet. Nothing observed is lost.
--
--   "ItemStatusHistory"      — existed solely to chart deployableStatus over
--     time. With the column gone its rows describe nothing. Every production
--     row was a migration-seeded baseline ('system:backfill') plus a handful of
--     bulk edits; no operator-entered observation is destroyed. The over-time
--     chart is rebuilt from the underlying signals instead (service-queue
--     timestamps, receipt open/close, markedReadyAt).
--
--   "DeployableStatus" type  — orphaned once the column is dropped. Readiness
--     states now live as a TypeScript union; Postgres has nothing to enumerate.
--
-- Two columns replace them:
--
--   Item."markedReadyAt" — the ONE hand-set signal, "this is back in our
--     possession". A timestamp, not a boolean, so a later logon supersedes it
--     and the marking self-expires rather than going stale.
--
--   Item."lastLogonAt"   — "lastLogonDate" (free text from the MDM export)
--     parsed to an instant at import time. Readiness compares the last logon
--     against markedReadyAt, and the dashboard makes that comparison across the
--     whole fleet in SQL; parsing the text column inside Postgres would abort an
--     import on the first unexpected format. Backfilled below on a best-effort
--     basis, then maintained by the importer.

-- DropForeignKey
ALTER TABLE "ItemStatusHistory" DROP CONSTRAINT "ItemStatusHistory_changedById_fkey";

-- DropForeignKey
ALTER TABLE "ItemStatusHistory" DROP CONSTRAINT "ItemStatusHistory_itemId_fkey";

-- AlterTable
ALTER TABLE "Item" DROP COLUMN "deployableStatus",
ADD COLUMN     "lastLogonAt" TIMESTAMP(3),
ADD COLUMN     "markedReadyAt" TIMESTAMP(3);

-- DropTable
DROP TABLE "ItemStatusHistory";

-- DropEnum
DROP TYPE "DeployableStatus";

-- CreateIndex
CREATE INDEX "Item_markedReadyAt_idx" ON "Item"("markedReadyAt");

-- CreateIndex
CREATE INDEX "Item_lastLogonAt_idx" ON "Item"("lastLogonAt");

-- Best-effort backfill of the parsed last-logon.
--
-- ONLY the exact shape the MDM export is known to emit ('M/D/YYYY h:mm:ss AM')
-- is converted; anything else is left NULL rather than guessed, because a wrong
-- instant here would silently flip a device's readiness. The regex guard means
-- to_timestamp never sees a string it cannot parse, so a malformed value can
-- not abort the migration. The importer parses in TypeScript
-- (parseLastLogonAt, unit-tested) and fills the rest on the next run; this only
-- avoids a fleet-wide "unknown" window between the migration and that import.
UPDATE "Item"
SET "lastLogonAt" = to_timestamp(btrim("lastLogonDate"), 'FMMM/FMDD/YYYY FMHH12:MI:SS AM')
WHERE "lastLogonDate" IS NOT NULL
  AND btrim("lastLogonDate") ~ '^\d{1,2}/\d{1,2}/\d{4} \d{1,2}:\d{2}:\d{2} (AM|PM)$';
