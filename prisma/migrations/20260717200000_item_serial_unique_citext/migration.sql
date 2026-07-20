-- serialNumber is a device's identity: make it case-insensitive (citext) and
-- unique so the same physical device cannot be logged twice, including with a
-- different casing. Verified 0 case-insensitive collisions across existing rows
-- before applying. The citext extension is already installed (public schema).
ALTER TABLE "Item" ALTER COLUMN "serialNumber" TYPE citext;
CREATE UNIQUE INDEX "Item_serialNumber_key" ON "Item"("serialNumber");
