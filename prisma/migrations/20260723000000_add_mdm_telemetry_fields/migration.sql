-- Add MDM telemetry columns to Item (all nullable, plain text)
ALTER TABLE "Item" ADD COLUMN "lastLogonUserPrincipalName" TEXT;
ALTER TABLE "Item" ADD COLUMN "lastLogonDate" TEXT;
ALTER TABLE "Item" ADD COLUMN "enrollmentDate" TEXT;
ALTER TABLE "Item" ADD COLUMN "compliance" TEXT;

-- Track how many items an import updated (in addition to added)
ALTER TABLE "ImportBatch" ADD COLUMN "updatedCount" INTEGER NOT NULL DEFAULT 0;
