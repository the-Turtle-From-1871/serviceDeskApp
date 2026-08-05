-- DropForeignKey
ALTER TABLE "TransferItem" DROP CONSTRAINT "TransferItem_itemId_fkey";

-- AlterTable
ALTER TABLE "TransferItem" ALTER COLUMN "itemId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "TransferItem" ADD CONSTRAINT "TransferItem_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE SET NULL ON UPDATE CASCADE;

