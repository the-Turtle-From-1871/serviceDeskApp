-- Deduplicate signature images into a content-addressed store.
--
-- ItemAudit.signatureImage and ReturnTransaction.processedBySignature each held a
-- full ~12 KB PNG data URL inline, byte-identical across every row a given admin
-- signed (31 audit rows / 1 distinct image in production). Both now reference
-- SignatureAsset by the SHA-256 of the image bytes.
--
-- Transfer.receiverSignature is deliberately NOT touched: recipient ink is unique
-- per receipt (11 rows / 11 distinct images), so there is nothing to deduplicate,
-- and it is covered by the Ed25519 receipt seal — rewriting how it is stored would
-- have to be reconciled with every already-signed manifest.

-- 1. The store. Content-addressed: the primary key IS the hash of `image`.
CREATE TABLE "SignatureAsset" (
    "sha256" TEXT NOT NULL,
    "image" TEXT NOT NULL,
    "byteLen" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SignatureAsset_pkey" PRIMARY KEY ("sha256")
);

-- 2. Backfill one row per DISTINCT image already stored inline. sha256() is a core
--    builtin (PG 11+); convert_to(...,'UTF8') makes the hashed bytes identical to
--    what Node's createHash("sha256").update(s,"utf8") sees.
INSERT INTO "SignatureAsset" ("sha256", "image", "byteLen")
SELECT DISTINCT
    encode(sha256(convert_to("signatureImage", 'UTF8')), 'hex'),
    "signatureImage",
    octet_length(convert_to("signatureImage", 'UTF8'))
FROM "ItemAudit"
ON CONFLICT ("sha256") DO NOTHING;

INSERT INTO "SignatureAsset" ("sha256", "image", "byteLen")
SELECT DISTINCT
    encode(sha256(convert_to("processedBySignature", 'UTF8')), 'hex'),
    "processedBySignature",
    octet_length(convert_to("processedBySignature", 'UTF8'))
FROM "ReturnTransaction"
WHERE "processedBySignature" IS NOT NULL
ON CONFLICT ("sha256") DO NOTHING;

-- 3. Point the history rows at it.
ALTER TABLE "ItemAudit" ADD COLUMN "signatureSha" TEXT;
ALTER TABLE "ReturnTransaction" ADD COLUMN "processedBySignatureSha" TEXT;

UPDATE "ItemAudit"
   SET "signatureSha" = encode(sha256(convert_to("signatureImage", 'UTF8')), 'hex');

UPDATE "ReturnTransaction"
   SET "processedBySignatureSha" = encode(sha256(convert_to("processedBySignature", 'UTF8')), 'hex')
 WHERE "processedBySignature" IS NOT NULL;

-- 4. Verify BEFORE destroying anything. This migration drops two columns of signed
--    history; it must abort rather than proceed on a partial copy. Every row must
--    resolve to an asset whose image is byte-identical to the blob it replaces.
--    A raised exception rolls the whole migration back (Prisma runs it in one txn).
DO $$
DECLARE bad INTEGER;
BEGIN
    SELECT count(*) INTO bad
      FROM "ItemAudit" a
      LEFT JOIN "SignatureAsset" s ON s."sha256" = a."signatureSha"
     WHERE a."signatureSha" IS NULL
        OR s."image" IS DISTINCT FROM a."signatureImage";
    IF bad > 0 THEN
        RAISE EXCEPTION 'ItemAudit signature backfill mismatch on % row(s) — aborting before DROP COLUMN', bad;
    END IF;

    SELECT count(*) INTO bad
      FROM "ReturnTransaction" r
      LEFT JOIN "SignatureAsset" s ON s."sha256" = r."processedBySignatureSha"
     WHERE r."processedBySignature" IS NOT NULL
       AND (r."processedBySignatureSha" IS NULL
            OR s."image" IS DISTINCT FROM r."processedBySignature");
    IF bad > 0 THEN
        RAISE EXCEPTION 'ReturnTransaction signature backfill mismatch on % row(s) — aborting before DROP COLUMN', bad;
    END IF;
END $$;

-- 5. Enforce and drop.
ALTER TABLE "ItemAudit" ALTER COLUMN "signatureSha" SET NOT NULL;
ALTER TABLE "ItemAudit" DROP COLUMN "signatureImage";
ALTER TABLE "ReturnTransaction" DROP COLUMN "processedBySignature";

-- 6. RESTRICT, not Cascade/SetNull: an asset must never be deleted out from under
--    a signed history row. Nothing deletes from SignatureAsset, so no index is
--    created on either referencing column — see the schema comment.
ALTER TABLE "ItemAudit"
    ADD CONSTRAINT "ItemAudit_signatureSha_fkey"
    FOREIGN KEY ("signatureSha") REFERENCES "SignatureAsset"("sha256")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ReturnTransaction"
    ADD CONSTRAINT "ReturnTransaction_processedBySignatureSha_fkey"
    FOREIGN KEY ("processedBySignatureSha") REFERENCES "SignatureAsset"("sha256")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- NOTE (ops): DROP COLUMN only unlinks the TOASTed blobs; Postgres does not return
-- the pages until the table is rewritten. Run `VACUUM FULL "ItemAudit";` and
-- `VACUUM FULL "ReturnTransaction";` after deploying to actually reclaim the disk.
-- Both take an ACCESS EXCLUSIVE lock, so they cannot run inside this migration.
