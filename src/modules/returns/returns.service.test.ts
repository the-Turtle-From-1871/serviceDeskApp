import { beforeAll, beforeEach, expect, test } from "vitest";
import prisma from "@/lib/prisma";
import { resetDb, migrateTestDb } from "../../../tests/helpers/db";
import { createTransfer, getTransferByReceiptNumber } from "@/modules/transfers/transfers.service";
import { createItem } from "@/modules/items/items.service";
import { processReturn } from "./returns.service";

const SIG = "data:image/png;base64,iVBORw0KGgo=";

let adminId: string;
beforeAll(() => migrateTestDb());
beforeEach(async () => {
  await resetDb();
  const admin = await prisma.user.create({ data: { name: "Tech", email: "t@x.co", passwordHash: "x", role: "ADMIN" } });
  adminId = admin.id;
});

// Build a receipt holding two Dell 5540 (one line, two serials).
async function seedReceipt() {
  const a = await createItem({ make: "Dell", model: "5540", serialNumber: "SN-A", deviceName: "Radio", homeUnit: undefined, notes: undefined }, adminId);
  const b = await createItem({ make: "Dell", model: "5540", serialNumber: "SN-B", deviceName: "Radio", homeUnit: undefined, notes: undefined }, adminId);
  const t = await createTransfer({
    itemIds: [a.id, b.id],
    lines: [{ make: "Dell", model: "5540", qtyAuth: 2, qtyIssued: 2 }],
    sender: { isDcsim: true, name: "Desk" },
    receiver: { isDcsim: false, name: "Jane", email: "jane@u.mil" },
    receiverSignature: "",
    createdByUserId: adminId,
  });
  const full = (await getTransferByReceiptNumber(t.receiptNumber))!;
  return { receiptNumber: t.receiptNumber, items: full.lines[0].items };
}

const processedBy = () => ({ id: adminId, name: "Tech", email: "t@x.co" });

test("partial return stamps returnedAt, writes a PARTIAL ledger row, keeps the receipt OPEN", async () => {
  const { receiptNumber, items } = await seedReceipt();
  const res = await processReturn({ receiptNumber, selectedItemIds: [items[0].id], signature: SIG, processedBy: processedBy() });
  if ("error" in res) throw new Error(res.error);
  expect(res.plan.kind).toBe("PARTIAL");

  const after = (await getTransferByReceiptNumber(receiptNumber))!;
  expect(after.status).toBe("OPEN");
  const returned = after.lines[0].items.filter((i) => i.returnedAt !== null);
  expect(returned).toHaveLength(1);
  expect(returned[0].id).toBe(items[0].id);

  const ledger = await prisma.returnTransaction.findMany();
  expect(ledger).toHaveLength(1);
  expect(ledger[0]).toMatchObject({ kind: "PARTIAL", returnedCount: 1, remainingCount: 1, receiptNumber });
  expect(ledger[0].processedBySignature).toBe(SIG);
});

test("returning the last held item closes the receipt as FULL", async () => {
  const { receiptNumber, items } = await seedReceipt();
  await processReturn({ receiptNumber, selectedItemIds: [items[0].id], signature: SIG, processedBy: processedBy() });
  const res = await processReturn({ receiptNumber, selectedItemIds: [items[1].id], signature: SIG, processedBy: processedBy() });
  if ("error" in res) throw new Error(res.error);
  expect(res.plan.kind).toBe("FULL");

  const after = (await getTransferByReceiptNumber(receiptNumber))!;
  expect(after.status).toBe("CLOSED");
  expect(after.lines[0].items.every((i) => i.returnedAt !== null)).toBe(true);
  expect(await prisma.returnTransaction.count()).toBe(2);
});

test("a return against a CLOSED receipt errors and writes nothing", async () => {
  const { receiptNumber, items } = await seedReceipt();
  await processReturn({ receiptNumber, selectedItemIds: [items[0].id, items[1].id], signature: SIG, processedBy: processedBy() });
  const before = await prisma.returnTransaction.count();
  const res = await processReturn({ receiptNumber, selectedItemIds: [items[0].id], signature: SIG, processedBy: processedBy() });
  expect("error" in res && res.error).toMatch(/closed/i);
  expect(await prisma.returnTransaction.count()).toBe(before);
});

test("selecting an already-returned item errors", async () => {
  const { receiptNumber, items } = await seedReceipt();
  await processReturn({ receiptNumber, selectedItemIds: [items[0].id], signature: SIG, processedBy: processedBy() });
  const res = await processReturn({ receiptNumber, selectedItemIds: [items[0].id], signature: SIG, processedBy: processedBy() });
  expect("error" in res && res.error).toMatch(/not currently held/i);
});
