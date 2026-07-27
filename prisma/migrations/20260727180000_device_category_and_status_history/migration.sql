-- AlterTable
ALTER TABLE "Item" ADD COLUMN     "deviceCategory" TEXT;

-- CreateTable
CREATE TABLE "ItemStatusHistory" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "deployableStatus" "DeployableStatus",
    "isAccountedFor" BOOLEAN NOT NULL,
    "changedById" TEXT,
    "changedByName" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ItemStatusHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ItemStatusHistory_itemId_createdAt_idx" ON "ItemStatusHistory"("itemId", "createdAt");

-- CreateIndex
CREATE INDEX "ItemStatusHistory_createdAt_idx" ON "ItemStatusHistory"("createdAt");

-- CreateIndex
CREATE INDEX "Item_deviceCategory_idx" ON "Item"("deviceCategory");

-- CreateIndex
CREATE INDEX "Item_deviceUIC_idx" ON "Item"("deviceUIC");

-- AddForeignKey
ALTER TABLE "ItemStatusHistory" ADD CONSTRAINT "ItemStatusHistory_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemStatusHistory" ADD CONSTRAINT "ItemStatusHistory_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Baseline snapshot: one row per existing item, recording the readiness state
-- it holds right now. This is the anchor the stacked-area chart steps from --
-- without it every item is invisible to the chart until someone happens to edit
-- it. No history is invented before this instant, because none exists: the
-- timeline legitimately starts the day it was introduced.
--
-- gen_random_uuid() (pgcrypto, built into Postgres 13+) supplies the id: cuid()
-- is generated in the Prisma client and is not available inside SQL. The column
-- is a plain TEXT id, so any unique string is valid.
INSERT INTO "ItemStatusHistory" ("id", "itemId", "deployableStatus", "isAccountedFor", "changedById", "changedByName", "source", "createdAt")
SELECT
    gen_random_uuid()::text,
    "id",
    "deployableStatus",
    "isAccountedFor",
    NULL,
    'System (baseline)',
    'system:backfill',
    NOW()
FROM "Item";
