import { beforeEach, expect, test } from "vitest";
import prisma from "@/lib/prisma";
import { resetDb } from "../../../tests/helpers/db";
import { putSignatureAsset, getSignatureAssetImage } from "./signature-asset.service";
import { signatureSha256 } from "@/lib/signature-hash";

const IMG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA";
const OTHER = "data:image/png;base64,ZZZZZZZZZZZZZZZZZZZZZZZZ";

beforeEach(() => resetDb());

const put = (image: string) => prisma.$transaction((tx) => putSignatureAsset(tx, image));

test("the same image stored repeatedly occupies exactly one row", async () => {
  // This is the whole point of the table: production held 31 audit rows carrying
  // 1 distinct ~12 KB image. Storing it N times must cost one row, not N.
  const shas = await Promise.all([put(IMG), put(IMG), put(IMG), put(IMG)]);
  expect(new Set(shas).size).toBe(1);
  expect(await prisma.signatureAsset.count()).toBe(1);
});

test("distinct images get distinct rows", async () => {
  await put(IMG);
  await put(OTHER);
  expect(await prisma.signatureAsset.count()).toBe(2);
});

test("a stored image round-trips byte-for-byte through its content address", async () => {
  const sha = await put(IMG);
  expect(sha).toBe(signatureSha256(IMG));
  expect(await getSignatureAssetImage(sha)).toBe(IMG);
});

test("getSignatureAssetImage returns null for an unknown address", async () => {
  expect(await getSignatureAssetImage(signatureSha256("never stored"))).toBeNull();
});

test("re-storing an image does not rewrite the existing row", async () => {
  const sha = await put(IMG);
  const first = await prisma.signatureAsset.findUniqueOrThrow({ where: { sha256: sha } });
  await put(IMG);
  const second = await prisma.signatureAsset.findUniqueOrThrow({ where: { sha256: sha } });
  // ON CONFLICT DO NOTHING, no update branch: the bytes behind a content address
  // can never change, so there is nothing to write and createdAt must not move.
  expect(second.createdAt).toEqual(first.createdAt);
  expect(second.image).toBe(IMG);
});

test("byteLen records the UTF-8 byte count Postgres sees", async () => {
  const sha = await put(IMG);
  const row = await prisma.signatureAsset.findUniqueOrThrow({ where: { sha256: sha } });
  const [{ octets }] = await prisma.$queryRaw<{ octets: number }[]>`
    SELECT octet_length(convert_to("image", 'UTF8')) AS octets
      FROM "SignatureAsset" WHERE "sha256" = ${sha}`;
  expect(row.byteLen).toBe(Number(octets));
});

// DRIFT GUARD. The backfill migration computed each row's key in SQL; the app
// computes it in Node. If those two ever disagree, an image already in the store
// is inserted again under a different key and the deduplication silently stops
// working — no error, just the old growth curve back. Assert they agree, on a
// string with multi-byte characters so the UTF-8 encoding is actually exercised.
test("the Node content address matches the SQL expression the migration used", async () => {
  for (const s of [IMG, "señor–π", "data:image/png;base64,AAA"]) {
    const [{ sql }] = await prisma.$queryRaw<{ sql: string }[]>`
      SELECT encode(sha256(convert_to(${s}, 'UTF8')), 'hex') AS sql`;
    expect(sql).toBe(signatureSha256(s));
  }
});
