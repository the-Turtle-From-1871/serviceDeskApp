-- AlterEnum
-- NOTE: 'VIEWER' is added here but deliberately NOT referenced anywhere else in
-- this migration. Postgres forbids using a new enum value in the same
-- transaction that added it, and Prisma runs each migration in one transaction.
ALTER TYPE "Role" ADD VALUE 'VIEWER';

-- CreateEnum
CREATE TYPE "Capability" AS ENUM (
  'VIEW_INVENTORY',
  'VIEW_ALL_RECEIPTS',
  'CREATE_RECEIPTS',
  'EDIT_ITEM_HOLDER',
  'MANAGE_ITEMS',
  'MANAGE_QUEUE',
  'PROCESS_RETURNS',
  'VIEW_ANALYTICS',
  'ADMINISTER'
);

-- CreateTable
CREATE TABLE "UserCapability" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "capability" "Capability" NOT NULL,
    "grantedById" TEXT,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserCapability_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserCapability_userId_capability_key" ON "UserCapability"("userId", "capability");

-- CreateIndex
CREATE INDEX "UserCapability_userId_idx" ON "UserCapability"("userId");

-- AddForeignKey
ALTER TABLE "UserCapability" ADD CONSTRAINT "UserCapability_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserCapability" ADD CONSTRAINT "UserCapability_grantedById_fkey"
  FOREIGN KEY ("grantedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
