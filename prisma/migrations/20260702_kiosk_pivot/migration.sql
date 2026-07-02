-- Wipe transfers + items + non-admin users (keep the admin account).
DELETE FROM "Transfer";
DELETE FROM "Item";
DELETE FROM "User" WHERE "role" <> 'ADMIN';

-- USER: add kiosk party fields.
ALTER TABLE "User" ADD COLUMN "unit" TEXT;
ALTER TABLE "User" ADD COLUMN "contactNumber" TEXT;

-- ITEM: rename homeLocation -> homeUnit, drop assetTag + currentHolder.
ALTER TABLE "Item" RENAME COLUMN "homeLocation" TO "homeUnit";
ALTER TABLE "Item" DROP CONSTRAINT IF EXISTS "Item_currentHolderId_fkey";
ALTER TABLE "Item" DROP COLUMN IF EXISTS "currentHolderId";
ALTER TABLE "Item" DROP COLUMN IF EXISTS "assetTag";

-- TRANSFER: drop old party/override columns, add snapshot columns.
DROP INDEX IF EXISTS "one_pending_transfer_per_item";
ALTER TABLE "Transfer" DROP CONSTRAINT IF EXISTS "Transfer_fromUserId_fkey";
ALTER TABLE "Transfer" DROP CONSTRAINT IF EXISTS "Transfer_toUserId_fkey";
ALTER TABLE "Transfer" DROP COLUMN "fromUserId";
ALTER TABLE "Transfer" DROP COLUMN "toUserId";
ALTER TABLE "Transfer" DROP COLUMN "fromUserName";
ALTER TABLE "Transfer" DROP COLUMN "toUserName";
ALTER TABLE "Transfer" DROP COLUMN "isOverride";
ALTER TABLE "Transfer" DROP COLUMN "actingAdminId";
ALTER TABLE "Transfer" DROP COLUMN "signatureImage";
ALTER TABLE "Transfer" DROP COLUMN "initiatedAt";
ALTER TABLE "Transfer" DROP COLUMN "signedAt";
ALTER TABLE "Transfer" DROP COLUMN "cancelledAt";

ALTER TABLE "Transfer" ADD COLUMN "receiptNumber" TEXT NOT NULL;
ALTER TABLE "Transfer" ADD COLUMN "senderIsDcsim" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Transfer" ADD COLUMN "senderName" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Transfer" ADD COLUMN "senderRank" TEXT;
ALTER TABLE "Transfer" ADD COLUMN "senderUnit" TEXT;
ALTER TABLE "Transfer" ADD COLUMN "senderContact" TEXT;
ALTER TABLE "Transfer" ADD COLUMN "senderEmail" TEXT;
ALTER TABLE "Transfer" ADD COLUMN "receiverIsDcsim" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Transfer" ADD COLUMN "receiverName" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Transfer" ADD COLUMN "receiverRank" TEXT;
ALTER TABLE "Transfer" ADD COLUMN "receiverUnit" TEXT;
ALTER TABLE "Transfer" ADD COLUMN "receiverContact" TEXT;
ALTER TABLE "Transfer" ADD COLUMN "receiverEmail" TEXT;
ALTER TABLE "Transfer" ADD COLUMN "receiverSignature" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Transfer" ADD COLUMN "createdByUserId" TEXT;
ALTER TABLE "Transfer" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Drop the DEFAULTs used only to satisfy NOT NULL on the (now empty) table.
ALTER TABLE "Transfer" ALTER COLUMN "senderName" DROP DEFAULT;
ALTER TABLE "Transfer" ALTER COLUMN "receiverName" DROP DEFAULT;
ALTER TABLE "Transfer" ALTER COLUMN "receiverSignature" DROP DEFAULT;

-- The old `TransferStatus` has PENDING/COMPLETED/CANCELLED. The table is
-- empty at this point, so recreate the type cleanly with just
-- COMPLETED/VOID (matching schema.prisma exactly) instead of leaving the
-- legacy labels lying around.
CREATE TYPE "TransferStatus_new" AS ENUM ('COMPLETED', 'VOID');
ALTER TABLE "Transfer" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Transfer" ALTER COLUMN "status" TYPE "TransferStatus_new" USING ("status"::text::"TransferStatus_new");
ALTER TYPE "TransferStatus" RENAME TO "TransferStatus_old";
ALTER TYPE "TransferStatus_new" RENAME TO "TransferStatus";
DROP TYPE "TransferStatus_old";
ALTER TABLE "Transfer" ALTER COLUMN "status" SET DEFAULT 'COMPLETED';

CREATE UNIQUE INDEX "Transfer_receiptNumber_key" ON "Transfer"("receiptNumber");
ALTER TABLE "Transfer"
  ADD CONSTRAINT "Transfer_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
