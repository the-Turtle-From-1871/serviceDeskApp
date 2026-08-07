-- The fleet export's "SLoc" column: where a device physically sits when
-- nobody holds it. Nullable free text, no index (see schema.prisma).
ALTER TABLE "Item" ADD COLUMN "storageLocation" TEXT;
