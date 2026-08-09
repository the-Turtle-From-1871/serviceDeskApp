import "server-only"; // reaches the DB — never bundle to the client
import type { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { signatureSha256, signatureByteLen } from "@/lib/signature-hash";

// The content-addressed signature store. See the `SignatureAsset` comment in
// prisma/schema.prisma for why signature blobs are not stored inline on the
// history rows that reference them.

type Tx = Prisma.TransactionClient;

/**
 * Store one signature image and return its content address.
 *
 * Takes a transaction client rather than reaching for the global `prisma`,
 * because both callers (recordAudit, processReturn) write the referencing row in
 * a transaction: the asset has to be visible to the FK check on that INSERT, and
 * a rolled-back audit must not leave an asset behind.
 *
 * Uses `INSERT … ON CONFLICT DO NOTHING` rather than a Prisma upsert so two
 * concurrent first-uses of the same new signature cannot race into a P2002 —
 * leaning on the DB constraint as the race-safe backstop, the same way the CSV
 * importer does with `createMany({ skipDuplicates: true })`. There is deliberately
 * no update branch: the key IS the hash of the bytes, so a conflicting row is
 * already byte-identical and there is nothing to write.
 */
export async function putSignatureAsset(tx: Tx, image: string): Promise<string> {
  const sha256 = signatureSha256(image);
  await tx.$executeRaw`
    INSERT INTO "SignatureAsset" ("sha256", "image", "byteLen")
    VALUES (${sha256}, ${image}, ${signatureByteLen(image)})
    ON CONFLICT ("sha256") DO NOTHING`;
  return sha256;
}

/** One stored image by content address. Null if the sha is unknown. */
export async function getSignatureAssetImage(sha256: string): Promise<string | null> {
  const row = await prisma.signatureAsset.findUnique({
    where: { sha256 },
    select: { image: true },
  });
  return row?.image ?? null;
}
