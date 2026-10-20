-- Replace Item.isLoaner (boolean) with Item.deviceClass (EUD | LOANER | STANDALONE).
--
-- Hand-written rather than generated: `prisma migrate diff` against this dev
-- database proposes dropping tables this schema does not describe, as it has
-- every time (see 20260827230000_transfer_notes).
--
-- The backfill is CONSERVATIVE AND LOSSLESS: isLoaner=true becomes LOANER, and
-- everything else becomes EUD, which is exactly the information the boolean
-- held. It deliberately does NOT try to infer a class from device names -- 43
-- devices named `NGHINB-PLOAN###` are unflagged today because the code's regex
-- only matches `NGHINB-LOAN-###`, and silently relabelling them inside a
-- migration would hide a data-quality decision inside a schema change.

CREATE TYPE "DeviceClass" AS ENUM ('EUD', 'LOANER', 'STANDALONE');

ALTER TABLE "Item" ADD COLUMN "deviceClass" "DeviceClass" NOT NULL DEFAULT 'EUD';

UPDATE "Item" SET "deviceClass" = 'LOANER' WHERE "isLoaner" = true;

-- Self-verifying, in the same transaction as the drop: refuse to destroy the
-- source column unless every row it marked survived the copy. Prisma runs a
-- migration file in one transaction, so a RAISE here rolls the whole file back
-- and leaves isLoaner intact. Same guard the manual prod migrations use before
-- a DROP COLUMN.
DO $$
DECLARE
  from_bool int;
  to_enum   int;
BEGIN
  SELECT count(*) INTO from_bool FROM "Item" WHERE "isLoaner" = true;
  SELECT count(*) INTO to_enum   FROM "Item" WHERE "deviceClass" = 'LOANER';
  IF from_bool <> to_enum THEN
    RAISE EXCEPTION 'deviceClass backfill mismatch: % loaner rows, % LOANER rows', from_bool, to_enum;
  END IF;
END $$;

DROP INDEX IF EXISTS "Item_isLoaner_idx";
ALTER TABLE "Item" DROP COLUMN "isLoaner";

-- Low-cardinality equality filter feeding a paginated list, same as
-- deviceCategory/deviceUIC.
CREATE INDEX "Item_deviceClass_idx" ON "Item"("deviceClass");
