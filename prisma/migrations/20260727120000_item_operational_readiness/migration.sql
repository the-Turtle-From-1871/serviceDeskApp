-- Operational-readiness tracking on Item (Day 1 sprint).
-- deployableStatus is nullable with no default: existing rows stay "unknown"
-- until triaged (no backfill from receipt state). isAccountedFor defaults true.

-- CreateEnum
CREATE TYPE "DeployableStatus" AS ENUM ('DEPLOYED', 'READY_TO_DEPLOY', 'IN_REPAIR', 'RETIRED');

-- AlterTable
ALTER TABLE "Item" ADD COLUMN     "deployableStatus" "DeployableStatus",
ADD COLUMN     "isAccountedFor" BOOLEAN NOT NULL DEFAULT true;
