-- CreateTable
CREATE TABLE "DeviceCategory" (
    "id" TEXT NOT NULL,
    "name" CITEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceCategory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeviceCategory_name_key" ON "DeviceCategory"("name");

-- CreateIndex
CREATE INDEX "DeviceCategory_createdById_idx" ON "DeviceCategory"("createdById");

-- AddForeignKey
ALTER TABLE "DeviceCategory" ADD CONSTRAINT "DeviceCategory_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Seed the vocabulary from categories already present on items, so the managed
-- list starts out matching reality instead of empty (any category typed into
-- the edit form or arriving via CSV before this migration would otherwise be
-- absent from the admin list, and look deletable/unknown).
-- DISTINCT over a citext column already folds case, so "Laptops"/"laptops"
-- collapse to one row and cannot violate the unique index.
INSERT INTO "DeviceCategory" ("id", "name", "createdById", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, DISTINCT_CATS."deviceCategory", NULL, NOW(), NOW()
FROM (
    SELECT DISTINCT "deviceCategory"
    FROM "Item"
    WHERE "deviceCategory" IS NOT NULL AND btrim("deviceCategory") <> ''
) AS DISTINCT_CATS;
