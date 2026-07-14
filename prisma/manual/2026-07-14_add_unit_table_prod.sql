-- Manual production migration for feature: device-name unit detection.
-- Applied via Supabase SQL Editor BEFORE pushing to main (Vercel does not
-- auto-migrate; see DEPLOY.md rule #1). Idempotent: safe to re-run.
--
-- Records migration 20260714184046_add_unit_table in _prisma_migrations
-- (checksum verified against prisma/migrations/.../migration.sql = sha256
-- 147cfcf263e1be2c90597de2050c08fbddf2e00acc0f06e0050b8f53674da742) so Prisma
-- history does not drift. Does NOT run `npm run db:seed` (that would create a
-- second admin, since local SEED_ADMIN_EMAIL != the prod admin bubbayajo21@gmail.com).

-- 1. Unit table (migration 20260714184046_add_unit_table, made idempotent)
CREATE TABLE IF NOT EXISTS "Unit" (
    "id" TEXT NOT NULL,
    "abbreviation" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Unit_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Unit_abbreviation_key" ON "Unit"("abbreviation");

-- 2. Seed the 71 HIARNG units (mirrors seedUnits() in prisma/seed.ts).
--    Does NOT touch the admin account, unlike `npm run db:seed`.
INSERT INTO "Unit" ("id", "abbreviation", "fullName", "createdAt", "updatedAt") VALUES
  (gen_random_uuid()::text, '103TC', '103 TRP CMD', NOW(), NOW()),
  (gen_random_uuid()::text, 'DCSIM', 'DCSIM', NOW(), NOW()),
  (gen_random_uuid()::text, '111AB', '111 ARMY BAND', NOW(), NOW()),
  (gen_random_uuid()::text, 'DOMS', 'Directorate of Military Support (J3)', NOW(), NOW()),
  (gen_random_uuid()::text, '126AV', '126TH AVN CO', NOW(), NOW()),
  (gen_random_uuid()::text, 'ENV', 'Environmental', NOW(), NOW()),
  (gen_random_uuid()::text, '140AV', '140 AVN Rgmt', NOW(), NOW()),
  (gen_random_uuid()::text, 'EOC', 'Emergency Operations Center', NOW(), NOW()),
  (gen_random_uuid()::text, '183AV', '183 AVN Rgmt', NOW(), NOW()),
  (gen_random_uuid()::text, 'ESGR', 'Employer Support of Guard and Reserve', NOW(), NOW()),
  (gen_random_uuid()::text, '189AV', '189 AVN Rgmt', NOW(), NOW()),
  (gen_random_uuid()::text, 'FMO', 'Facility Maintenance Office', NOW(), NOW()),
  (gen_random_uuid()::text, '207AV', '207 AVN Rgmt', NOW(), NOW()),
  (gen_random_uuid()::text, '1950', '1950 Commercial Contracting Team', NOW(), NOW()),
  (gen_random_uuid()::text, 'FMS1', 'Field Maint Shop 1 (Kalaeloa)', NOW(), NOW()),
  (gen_random_uuid()::text, 'FMS2', 'Field Maint Shop 2 (Wahiawa)', NOW(), NOW()),
  (gen_random_uuid()::text, '211AV', '211 AVN Rgmt', NOW(), NOW()),
  (gen_random_uuid()::text, 'FMS3', 'Field Maint Shop 3 (Maui)', NOW(), NOW()),
  (gen_random_uuid()::text, '230EN', '230 EN Co', NOW(), NOW()),
  (gen_random_uuid()::text, 'FMS5', 'Field Maint Shop 5 (Kauai)', NOW(), NOW()),
  (gen_random_uuid()::text, '297EN', '297 EN Det', NOW(), NOW()),
  (gen_random_uuid()::text, 'G1', 'G1', NOW(), NOW()),
  (gen_random_uuid()::text, '298RT', '298 Regmt', NOW(), NOW()),
  (gen_random_uuid()::text, 'G2', 'G2', NOW(), NOW()),
  (gen_random_uuid()::text, '299A', '299CAV TRP A', NOW(), NOW()),
  (gen_random_uuid()::text, 'G3', 'G3', NOW(), NOW()),
  (gen_random_uuid()::text, '299B', '299CAV TRP B', NOW(), NOW()),
  (gen_random_uuid()::text, 'G4', 'G4', NOW(), NOW()),
  (gen_random_uuid()::text, '299C', '299CAV TRP C', NOW(), NOW()),
  (gen_random_uuid()::text, 'MFH', 'Military Funeral Honors', NOW(), NOW()),
  (gen_random_uuid()::text, '299D', '299CAV D Co (DFSC)', NOW(), NOW()),
  (gen_random_uuid()::text, 'HRO', 'HRO', NOW(), NOW()),
  (gen_random_uuid()::text, '299H', '299CAV HQ', NOW(), NOW()),
  (gen_random_uuid()::text, 'JFHHD', 'JFHQ HHD', NOW(), NOW()),
  (gen_random_uuid()::text, '29BCT', '29th IBCT', NOW(), NOW()),
  (gen_random_uuid()::text, 'MED', 'Medical Dettachment', NOW(), NOW()),
  (gen_random_uuid()::text, '445AV', '445 AVN SPT BN', NOW(), NOW()),
  (gen_random_uuid()::text, 'MPAD', '117 Mobile Public Affairs Det', NOW(), NOW()),
  (gen_random_uuid()::text, '487A', '487FA BATTERY A', NOW(), NOW()),
  (gen_random_uuid()::text, 'PAO', 'Public Affairs Office', NOW(), NOW()),
  (gen_random_uuid()::text, '487B', '487FA BATTERY B', NOW(), NOW()),
  (gen_random_uuid()::text, 'PBO', 'Property Book Office', NOW(), NOW()),
  (gen_random_uuid()::text, '487F', '487FA Co F (FFSC)', NOW(), NOW()),
  (gen_random_uuid()::text, 'PUBS', 'Publications', NOW(), NOW()),
  (gen_random_uuid()::text, '487H', '487FA HQ', NOW(), NOW()),
  (gen_random_uuid()::text, 'RAID', 'Recon and Interdiction Det', NOW(), NOW()),
  (gen_random_uuid()::text, '641AV', '641 AVN Rgmt', NOW(), NOW()),
  (gen_random_uuid()::text, 'RRB', 'Recruiting and Retention Battalion', NOW(), NOW()),
  (gen_random_uuid()::text, '93CST', '93 CST', NOW(), NOW()),
  (gen_random_uuid()::text, 'RTSM', 'Regional Training Site Maint', NOW(), NOW()),
  (gen_random_uuid()::text, 'SAFE', 'Safety Office', NOW(), NOW()),
  (gen_random_uuid()::text, 'SFP', 'State Family Program', NOW(), NOW()),
  (gen_random_uuid()::text, 'USPFO', 'USPFO', NOW(), NOW()),
  (gen_random_uuid()::text, 'UTES', 'UTES', NOW(), NOW()),
  (gen_random_uuid()::text, 'AASF1', 'Army Aviation Support Facility 1', NOW(), NOW()),
  (gen_random_uuid()::text, 'AASF2', 'Army Aviation Support Facility 2', NOW(), NOW()),
  (gen_random_uuid()::text, 'BSBA', 'Brigade Support Battalion Co A', NOW(), NOW()),
  (gen_random_uuid()::text, 'BSBB', 'Brigade Support Battalion Co B', NOW(), NOW()),
  (gen_random_uuid()::text, 'BSBC', 'Brigade Support Battalion Co C', NOW(), NOW()),
  (gen_random_uuid()::text, 'BSBH', 'Brigade Support Battalion HQ', NOW(), NOW()),
  (gen_random_uuid()::text, 'BEBA', 'Brigade Engineer Battalion Co A (EN)', NOW(), NOW()),
  (gen_random_uuid()::text, 'BEBB', 'Brigade Engineer Battalion Co B (EN)', NOW(), NOW()),
  (gen_random_uuid()::text, 'BEBC', 'Brigade Engineer Battalion Co C (SIGNAL)', NOW(), NOW()),
  (gen_random_uuid()::text, 'BEBD', 'Brigade Engineer Battalion Co D (MI)', NOW(), NOW()),
  (gen_random_uuid()::text, 'BEBE', 'Brigade Engineer Battalion Co E (EFSC)', NOW(), NOW()),
  (gen_random_uuid()::text, 'BEBH', 'Brigade Engineer Battalion HQ', NOW(), NOW()),
  (gen_random_uuid()::text, 'CD', 'Counter Drug', NOW(), NOW()),
  (gen_random_uuid()::text, 'CERFP', 'CERFP', NOW(), NOW()),
  (gen_random_uuid()::text, 'COFS', 'Chief of Staff Office', NOW(), NOW()),
  (gen_random_uuid()::text, 'CSMS1', 'Combined Support Maint Shop 1', NOW(), NOW()),
  (gen_random_uuid()::text, 'CSMS2', 'Combined Support Maint Shop 2', NOW(), NOW())
ON CONFLICT ("abbreviation") DO UPDATE
  SET "fullName" = EXCLUDED."fullName", "updatedAt" = NOW();

-- 3. Record the migration so Prisma's history doesn't drift further.
INSERT INTO "_prisma_migrations"
  ("id","checksum","finished_at","migration_name","logs","rolled_back_at","started_at","applied_steps_count")
SELECT gen_random_uuid()::text, '147cfcf263e1be2c90597de2050c08fbddf2e00acc0f06e0050b8f53674da742', NOW(), '20260714184046_add_unit_table', NULL, NULL, NOW(), 1
WHERE NOT EXISTS (
  SELECT 1 FROM "_prisma_migrations" WHERE "migration_name" = '20260714184046_add_unit_table'
);

-- 4. Verify — expect 71
SELECT COUNT(*) AS units FROM "Unit";
