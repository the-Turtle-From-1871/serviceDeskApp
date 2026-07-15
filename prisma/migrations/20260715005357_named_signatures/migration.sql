-- CreateTable
CREATE TABLE "Signature" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "image" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Signature_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Signature_userId_idx" ON "Signature"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Signature_userId_name_key" ON "Signature"("userId", "name");

-- AddForeignKey
ALTER TABLE "Signature" ADD CONSTRAINT "Signature_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Discard superseded single signatures for ADMIN accounts: admins now use named
-- signatures (table "Signature"). Non-admin rows are deliberately left alone —
-- they keep the single-signature model on User.signatureImage.
UPDATE "User" SET "signatureImage" = NULL WHERE "role" = 'ADMIN';
