-- AlterTable
ALTER TABLE "User" ADD COLUMN "signatureImage" TEXT;

-- AlterTable
ALTER TABLE "ReturnTransaction" ADD COLUMN "processedBySignature" TEXT;
