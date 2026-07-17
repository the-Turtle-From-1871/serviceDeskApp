-- CreateTable
CREATE TABLE "ItemAudit" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "auditedById" TEXT,
    "auditedByName" TEXT NOT NULL,
    "signerName" TEXT NOT NULL,
    "signatureImage" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ItemAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ItemAudit_itemId_createdAt_idx" ON "ItemAudit"("itemId", "createdAt");

-- AddForeignKey
ALTER TABLE "ItemAudit" ADD CONSTRAINT "ItemAudit_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemAudit" ADD CONSTRAINT "ItemAudit_auditedById_fkey" FOREIGN KEY ("auditedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
