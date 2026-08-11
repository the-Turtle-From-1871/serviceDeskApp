import { beforeAll, beforeEach, expect, test } from "vitest";
import prisma from "@/lib/prisma";
import { resetDb } from "../../../tests/helpers/db";
import { backfillContactsFromReceipts } from "./backfill";
import { listContacts, createContact } from "./contacts.service";

let userId: string;
let seq = 0;

beforeEach(async () => {
  await resetDb();
  seq = 0;
  const u = await prisma.user.create({
    data: { name: "Tech", email: "t@x.co", passwordHash: "x", role: "ADMIN" },
  });
  userId = u.id;
});

/** A filed receipt. `createdAt` is explicit so "newest wins" is deterministic. */
async function receipt(
  createdAt: Date,
  receiver: Partial<{ isDcsim: boolean; name: string; rank: string; unit: string; contact: string; email: string }>,
  sender: Partial<{ isDcsim: boolean; name: string; rank: string; unit: string; contact: string; email: string }> = { isDcsim: true, name: "DCSIM Tech" },
  createdByUserId: string | null = userId,
) {
  seq += 1;
  return prisma.transfer.create({
    data: {
      receiptNumber: `HR-${String(seq).padStart(6, "0")}`,
      itemSummary: "1x Dell 5540",
      createdAt,
      createdByUserId,
      senderIsDcsim: sender.isDcsim ?? false,
      senderName: sender.name ?? "Sender",
      senderRank: sender.rank ?? null,
      senderUnit: sender.unit ?? null,
      senderContact: sender.contact ?? null,
      senderEmail: sender.email ?? null,
      receiverIsDcsim: receiver.isDcsim ?? false,
      receiverName: receiver.name ?? "Doe, Jane",
      receiverRank: receiver.rank ?? null,
      receiverUnit: receiver.unit ?? null,
      receiverContact: receiver.contact ?? null,
      receiverEmail: receiver.email ?? null,
      receiverSignature: "data:image/png;base64,AAA",
    },
  });
}

const OLD = new Date("2026-01-01T00:00:00Z");
const NEW = new Date("2026-06-01T00:00:00Z");

test("files a non-DCSIM receiver from an existing receipt", async () => {
  await receipt(OLD, { name: "Doe, Jane", rank: "SGT", unit: "A Co", contact: "555-0100", email: "jane@unit.mil" });

  const r = await backfillContactsFromReceipts();

  expect(r).toMatchObject({ receiptsScanned: 1, distinctPeople: 1, created: 1, updated: 0, skipped: 0 });
  expect(await listContacts()).toMatchObject([
    { firstName: "Jane", lastName: "Doe", rank: "SGT", unit: "A Co", contactNumber: "555-0100", email: "jane@unit.mil", createdById: userId },
  ]);
});

test("newest receipt wins, and one person costs one write no matter how many receipts", async () => {
  await receipt(OLD, { name: "Doe, Jane", unit: "Old Co", contact: "555-0000", email: "jane@unit.mil" });
  await receipt(NEW, { name: "Doe, Jane", unit: "New Co", contact: "555-9999", email: "jane@unit.mil" });

  const r = await backfillContactsFromReceipts();

  expect(r).toMatchObject({ receiptsScanned: 2, partiesSeen: 2, distinctPeople: 1, created: 1 });
  expect(await listContacts()).toMatchObject([{ unit: "New Co", contactNumber: "555-9999" }]);
});

test("matches an existing contact case-insensitively and refreshes it", async () => {
  await createContact({ firstName: "Jane", lastName: "Doe", email: "jane@unit.mil", unit: "Stale Co" }, userId);
  await receipt(NEW, { name: "Doe, Jane", unit: "Current Co", email: "JANE@Unit.MIL" });

  const r = await backfillContactsFromReceipts();

  expect(r).toMatchObject({ distinctPeople: 1, created: 0, updated: 1 });
  const rows = await listContacts();
  expect(rows).toHaveLength(1);
  expect(rows[0].unit).toBe("Current Co");
});

test("does not rewrite the name of a contact that already exists", async () => {
  // Same create-only rule as the live path: re-splitting a name that was
  // already filed correctly is how "Mary Jo"/"Smith" becomes "Mary"/"Jo Smith".
  await createContact({ firstName: "Mary Jo", lastName: "Smith", email: "mj@unit.mil" }, userId);
  await receipt(NEW, { name: "Mary Jo Smith", unit: "B Co", email: "mj@unit.mil" });

  await backfillContactsFromReceipts();

  expect(await listContacts()).toMatchObject([{ firstName: "Mary Jo", lastName: "Smith", unit: "B Co" }]);
});

test("skips DCSIM parties on both sides", async () => {
  await receipt(
    NEW,
    { isDcsim: true, name: "DCSIM Tech" },
    { isDcsim: true, name: "Other Tech" },
  );

  const r = await backfillContactsFromReceipts();

  expect(r).toMatchObject({ receiptsScanned: 1, partiesSeen: 0, distinctPeople: 0, created: 0 });
  expect(await listContacts()).toEqual([]);
});

test("files an outside SENDER too — kit handed back by someone not in the book", async () => {
  await receipt(
    NEW,
    { isDcsim: true, name: "DCSIM Tech" },
    { isDcsim: false, name: "Roe, Bob", unit: "C Co", contact: "555-0123", email: "bob@unit.mil" },
  );

  const r = await backfillContactsFromReceipts();

  expect(r).toMatchObject({ distinctPeople: 1, created: 1 });
  expect(await listContacts()).toMatchObject([{ firstName: "Bob", lastName: "Roe", unit: "C Co" }]);
});

test("counts a party with no email as absent, and an unsplittable name as skipped", async () => {
  await receipt(OLD, { name: "Doe, Jane", email: null as unknown as undefined });
  await receipt(NEW, { name: "Cher", email: "cher@unit.mil" });

  const r = await backfillContactsFromReceipts();

  // The emailless party never becomes a candidate; the one-word name does, and
  // is then refused by the parser rather than saved under a placeholder.
  expect(r).toMatchObject({ receiptsScanned: 2, partiesSeen: 1, distinctPeople: 1, created: 0, skipped: 1 });
  expect(await listContacts()).toEqual([]);
});

test("attributes each contact to the technician who filed that receipt, and tolerates a deleted one", async () => {
  await receipt(NEW, { name: "Doe, Jane", email: "jane@unit.mil" }, { isDcsim: true, name: "T" }, null);

  await backfillContactsFromReceipts();

  expect((await listContacts())[0].createdById).toBeNull();
});

test("is idempotent — a second run creates nothing new", async () => {
  await receipt(NEW, { name: "Doe, Jane", unit: "A Co", email: "jane@unit.mil" });

  const first = await backfillContactsFromReceipts();
  const second = await backfillContactsFromReceipts();

  expect(first).toMatchObject({ created: 1, updated: 0 });
  expect(second).toMatchObject({ created: 0, updated: 1 });
  expect(await listContacts()).toHaveLength(1);
});

test("dryRun reports the same outcome it would apply, and writes nothing", async () => {
  await createContact({ firstName: "Jane", lastName: "Doe", email: "jane@unit.mil" }, userId);
  await receipt(NEW, { name: "Doe, Jane", unit: "A Co", email: "jane@unit.mil" });
  await receipt(NEW, { name: "Roe, Bob", email: "bob@unit.mil" });
  await receipt(NEW, { name: "Cher", email: "cher@unit.mil" });

  const preview = await backfillContactsFromReceipts({ dryRun: true });
  expect(preview).toMatchObject({ distinctPeople: 3, created: 1, updated: 1, skipped: 1 });
  expect(await listContacts()).toHaveLength(1); // untouched

  const applied = await backfillContactsFromReceipts();
  expect(applied).toMatchObject({ created: preview.created, updated: preview.updated, skipped: preview.skipped });
});

test("scans past one batch — pagination is a cursor, not an offset", async () => {
  // SCAN_BATCH is 500; 501 receipts proves the second page is fetched and that
  // the cursor does not re-serve or drop the boundary row.
  const rows = Array.from({ length: 501 }, (_, i) => ({
    receiptNumber: `HR-B${String(i).padStart(6, "0")}`,
    itemSummary: "1x Dell 5540",
    createdAt: new Date(Date.UTC(2026, 0, 1) + i * 1000),
    createdByUserId: userId,
    senderIsDcsim: true,
    senderName: "DCSIM Tech",
    receiverIsDcsim: false,
    receiverName: `Doe, P${i}`,
    receiverEmail: `p${i}@unit.mil`,
    receiverSignature: "data:image/png;base64,AAA",
  }));
  await prisma.transfer.createMany({ data: rows });

  const r = await backfillContactsFromReceipts();

  expect(r.receiptsScanned).toBe(501);
  expect(r.distinctPeople).toBe(501);
  expect(r.created).toBe(501);
});
