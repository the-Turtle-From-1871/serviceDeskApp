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
-- CAREFUL: Item."deviceCategory" is plain TEXT, but DeviceCategory."name" is
-- CITEXT UNIQUE. A bare `SELECT DISTINCT` is therefore CASE-SENSITIVE and would
-- emit "Laptops" and "laptops" as two rows, which the citext unique index
-- rejects — aborting the migration mid-deploy. So fold case explicitly with
-- DISTINCT ON (lower(...)) and normalize the stored value (trim + collapse
-- internal whitespace) to match normalizeCategoryName in the app; otherwise a
-- seeded row like " Laptops" never matches what the app writes.
-- MIN() picks a deterministic representative among case variants.
INSERT INTO "DeviceCategory" ("id", "name", "createdById", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, normalized_name, NULL, NOW(), NOW()
FROM (
    SELECT MIN(regexp_replace(btrim("deviceCategory"), '\s+', ' ', 'g')) AS normalized_name
    FROM "Item"
    WHERE "deviceCategory" IS NOT NULL
      AND btrim("deviceCategory") <> ''
    GROUP BY lower(regexp_replace(btrim("deviceCategory"), '\s+', ' ', 'g'))
) AS distinct_cats;
