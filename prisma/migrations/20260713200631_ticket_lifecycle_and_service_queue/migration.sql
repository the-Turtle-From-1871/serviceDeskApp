-- CreateEnum
CREATE TYPE "ServiceQueueStatus" AS ENUM ('PENDING', 'READY_TO_ISSUE');

-- AlterTable
ALTER TABLE "Transfer" ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "purgeAfter" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "deactivatedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ServiceQueueItem" (
    "id" TEXT NOT NULL,
    "transferId" TEXT NOT NULL,
    "status" "ServiceQueueStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceQueueItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ServiceQueueItem_transferId_idx" ON "ServiceQueueItem"("transferId");

-- CreateIndex
CREATE INDEX "ServiceQueueItem_status_idx" ON "ServiceQueueItem"("status");

-- CreateIndex
CREATE INDEX "Transfer_purgeAfter_idx" ON "Transfer"("purgeAfter");

-- AddForeignKey
ALTER TABLE "ServiceQueueItem" ADD CONSTRAINT "ServiceQueueItem_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "Transfer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
