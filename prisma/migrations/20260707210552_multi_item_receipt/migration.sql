/*
  Warnings:

  - You are about to drop the column `itemId` on the `Transfer` table. All the data in the column will be lost.

*/
-- Ensure gen_random_uuid() is available for the backfill below.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- CreateTable
CREATE TABLE "TransferLine" (
    "id" TEXT NOT NULL,
    "transferId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "make" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "unitOfIssue" TEXT NOT NULL DEFAULT 'EA',
    "qtyAuth" INTEGER NOT NULL,
    "qtyIssued" INTEGER NOT NULL,

    CONSTRAINT "TransferLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransferItem" (
    "id" TEXT NOT NULL,
    "transferLineId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "serialNumber" TEXT NOT NULL,

    CONSTRAINT "TransferItem_pkey" PRIMARY KEY ("id")
);

-- Backfill: one line + one item per existing single-item transfer.
INSERT INTO "TransferLine" (id, "transferId", "lineNo", make, model, "unitOfIssue", "qtyAuth", "qtyIssued")
SELECT gen_random_uuid()::text, t.id, 1, i.make, i.model, 'EA', 1, 1
FROM "Transfer" t
JOIN "Item" i ON i.id = t."itemId";

INSERT INTO "TransferItem" (id, "transferLineId", "itemId", "serialNumber")
SELECT gen_random_uuid()::text, l.id, t."itemId", i."serialNumber"
FROM "Transfer" t
JOIN "Item" i ON i.id = t."itemId"
JOIN "TransferLine" l ON l."transferId" = t.id AND l."lineNo" = 1;

-- CreateIndex
CREATE INDEX "TransferLine_transferId_idx" ON "TransferLine"("transferId");

-- CreateIndex
CREATE INDEX "TransferItem_itemId_idx" ON "TransferItem"("itemId");

-- CreateIndex
CREATE INDEX "TransferItem_transferLineId_idx" ON "TransferItem"("transferLineId");

-- AddForeignKey
ALTER TABLE "TransferLine" ADD CONSTRAINT "TransferLine_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "Transfer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransferItem" ADD CONSTRAINT "TransferItem_transferLineId_fkey" FOREIGN KEY ("transferLineId") REFERENCES "TransferLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransferItem" ADD CONSTRAINT "TransferItem_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- DropForeignKey
ALTER TABLE "Transfer" DROP CONSTRAINT "Transfer_itemId_fkey";

-- AlterTable
ALTER TABLE "Transfer" DROP COLUMN "itemId";
