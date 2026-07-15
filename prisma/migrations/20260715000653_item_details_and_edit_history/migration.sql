-- AlterTable
ALTER TABLE "Item" ADD COLUMN     "currentPosition" TEXT,
ADD COLUMN     "currentUser" TEXT;

-- CreateTable
CREATE TABLE "ItemEdit" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "editedById" TEXT,
    "editedByName" TEXT NOT NULL,
    "changes" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ItemEdit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ItemEdit_itemId_idx" ON "ItemEdit"("itemId");

-- CreateIndex
CREATE INDEX "ItemEdit_createdAt_idx" ON "ItemEdit"("createdAt");

-- AddForeignKey
ALTER TABLE "ItemEdit" ADD CONSTRAINT "ItemEdit_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemEdit" ADD CONSTRAINT "ItemEdit_editedById_fkey" FOREIGN KEY ("editedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
