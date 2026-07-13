-- [Ingest & Routing Queue] Hand-authored, NOT YET APPLIED. The shared local DB
-- is used concurrently by another feature branch, so this must be consolidated
-- with their pending migration(s) before running `prisma migrate dev/deploy`.

-- CreateEnum
CREATE TYPE "ServiceQueueStatus" AS ENUM ('PENDING', 'READY_TO_ISSUE');

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

-- AddForeignKey
ALTER TABLE "ServiceQueueItem" ADD CONSTRAINT "ServiceQueueItem_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "Transfer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
