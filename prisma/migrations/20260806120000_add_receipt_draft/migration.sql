-- CreateTable
CREATE TABLE "ReceiptDraft" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "recipientName" TEXT,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReceiptDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReceiptDraft_userId_updatedAt_idx" ON "ReceiptDraft"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "ReceiptDraft_updatedAt_idx" ON "ReceiptDraft"("updatedAt");

-- AddForeignKey
ALTER TABLE "ReceiptDraft" ADD CONSTRAINT "ReceiptDraft_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

