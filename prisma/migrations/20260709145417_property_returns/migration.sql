-- CreateEnum
CREATE TYPE "ReturnKind" AS ENUM ('PARTIAL', 'FULL');

-- AlterEnum: TransferStatus COMPLETED|VOID -> OPEN|CLOSED (preserve existing rows)
ALTER TYPE "TransferStatus" RENAME TO "TransferStatus_old";
CREATE TYPE "TransferStatus" AS ENUM ('OPEN', 'CLOSED');
ALTER TABLE "Transfer" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Transfer" ALTER COLUMN "status" TYPE "TransferStatus"
  USING (CASE "status"::text WHEN 'VOID' THEN 'CLOSED' ELSE 'OPEN' END)::"TransferStatus";
ALTER TABLE "Transfer" ALTER COLUMN "status" SET DEFAULT 'OPEN';
DROP TYPE "TransferStatus_old";

-- AlterTable
ALTER TABLE "TransferItem" ADD COLUMN "returnedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ReturnTransaction" (
    "id" TEXT NOT NULL,
    "transferId" TEXT NOT NULL,
    "receiptNumber" TEXT NOT NULL,
    "kind" "ReturnKind" NOT NULL,
    "processedByUserId" TEXT,
    "processedByName" TEXT NOT NULL,
    "processedByEmail" TEXT NOT NULL,
    "returned" JSONB NOT NULL,
    "returnedCount" INTEGER NOT NULL,
    "remainingCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReturnTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReturnTransaction_transferId_idx" ON "ReturnTransaction"("transferId");

-- AddForeignKey
ALTER TABLE "ReturnTransaction" ADD CONSTRAINT "ReturnTransaction_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "Transfer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnTransaction" ADD CONSTRAINT "ReturnTransaction_processedByUserId_fkey" FOREIGN KEY ("processedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
