import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import prisma from "@/lib/prisma";
import { resetDb, migrateTestDb } from "../../../tests/helpers/db";
import { createItem } from "@/modules/items/items.service";
import { createTransfer, getTransferByReceiptNumber } from "./transfers.service";
import { manifestFromTransfer } from "./seal";
import { verifyCryptographicSeal } from "@/lib/crypto";

// Real DB, not vi.mock, and a real signing key. Every other seal test either
// mocks @/lib/prisma (transfers.service.test.ts) or verifies purely in-memory
// manifests (seal.test.ts) — neither proves the signature verifies against a
// row that actually round-tripped through Postgres, including the citext
// serialNumber column and the TIMESTAMP(3) sealedAt column, either of which
// could silently reshape bytes on write/read. This file is the one place
// that proves the persisted row still verifies.

const SIG = "data:image/png;base64,iVBORw0KGgo=";

let adminId: string;
const savedKey = process.env.SIGNING_PRIVATE_KEY;

beforeAll(() => migrateTestDb());

beforeEach(async () => {
  await resetDb();
  const { privateKey } = generateKeyPairSync("ed25519");
  process.env.SIGNING_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const admin = await prisma.user.create({
    data: { name: "Tech", email: "t@x.co", passwordHash: "x", role: "ADMIN" },
  });
  adminId = admin.id;
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.SIGNING_PRIVATE_KEY;
  else process.env.SIGNING_PRIVATE_KEY = savedKey;
});

const newItem = (serialNumber: string) =>
  createItem({ make: "Dell", model: "5540", serialNumber, deviceName: "Laptop", homeUnit: undefined, notes: undefined }, adminId);

describe("createTransfer seal round-trip (real DB)", () => {
  it("verifies against a row re-read from Postgres, including a mixed-case citext serial, and rejects a tampered re-read", async () => {
    const a = await newItem("SN-REAL-1");
    // Mixed-case serial exercises the citext round trip: stored case must be
    // preserved (citext is case-INSENSITIVE for comparison, not lossy).
    const b = await newItem("Abc-123");

    const created = await createTransfer({
      itemIds: [a.id, b.id],
      lines: [{ make: "Dell", model: "5540", qtyAuth: 2, qtyIssued: 2 }],
      sender: { isDcsim: true, name: "Desk" },
      receiver: { isDcsim: false, name: "Jane", rank: "SGT", unit: "A Co", contact: "808", email: "jane@u.mil" },
      receiverSignature: SIG,
      createdByUserId: adminId,
    });

    const row = await getTransferByReceiptNumber(created.receiptNumber);
    expect(row).not.toBeNull();
    expect(row!.cryptoSignature).toBeTypeOf("string");
    expect(row!.sealedAt).toBeInstanceOf(Date);

    // The load-bearing assertion: the persisted TIMESTAMP(3) sealedAt and the
    // persisted (citext) serials reproduce the exact signed bytes after a
    // real Postgres write + read.
    const manifest = manifestFromTransfer(row!)!;
    expect(verifyCryptographicSeal(manifest, row!.cryptoSignature!)).toBe(true);

    // Tamper case: mutate a signed field directly on the persisted row (as an
    // attacker with DB access would), re-read, and confirm the seal now
    // reports invalid rather than silently re-verifying.
    await prisma.transfer.update({ where: { id: row!.id }, data: { receiverName: "Changed Name" } });
    const tampered = await getTransferByReceiptNumber(created.receiptNumber);
    const tamperedManifest = manifestFromTransfer(tampered!)!;
    expect(verifyCryptographicSeal(tamperedManifest, tampered!.cryptoSignature!)).toBe(false);
  });
});
