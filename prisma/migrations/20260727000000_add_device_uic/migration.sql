-- Add the device UIC (Unit Identification Code) column to Item (nullable text)
ALTER TABLE "Item" ADD COLUMN "deviceUIC" TEXT;
