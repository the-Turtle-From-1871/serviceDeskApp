-- Discard old receipt-level queue rows (no item association); the queue is now item-level.
DELETE FROM "ServiceQueueItem";

-- CreateEnum
CREATE TYPE "ServiceType" AS ENUM ('REIMAGE', 'REPAIR', 'OTHER');

-- AlterEnum
BEGIN;
CREATE TYPE "ServiceQueueStatus_new" AS ENUM ('PENDING', 'COMPLETED');
ALTER TABLE "public"."ServiceQueueItem" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "ServiceQueueItem" ALTER COLUMN "status" TYPE "ServiceQueueStatus_new" USING ("status"::text::"ServiceQueueStatus_new");
ALTER TYPE "ServiceQueueStatus" RENAME TO "ServiceQueueStatus_old";
ALTER TYPE "ServiceQueueStatus_new" RENAME TO "ServiceQueueStatus";
DROP TYPE "public"."ServiceQueueStatus_old";
ALTER TABLE "ServiceQueueItem" ALTER COLUMN "status" SET DEFAULT 'PENDING';
COMMIT;

-- DropForeignKey
ALTER TABLE "ServiceQueueItem" DROP CONSTRAINT "ServiceQueueItem_transferId_fkey";

-- AlterTable
ALTER TABLE "ServiceQueueItem" ADD COLUMN     "itemId" TEXT NOT NULL,
ADD COLUMN     "serviceNote" TEXT,
ADD COLUMN     "serviceType" "ServiceType" NOT NULL,
ALTER COLUMN "transferId" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "ServiceQueueItem_itemId_key" ON "ServiceQueueItem"("itemId");

-- AddForeignKey
ALTER TABLE "ServiceQueueItem" ADD CONSTRAINT "ServiceQueueItem_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceQueueItem" ADD CONSTRAINT "ServiceQueueItem_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "Transfer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
