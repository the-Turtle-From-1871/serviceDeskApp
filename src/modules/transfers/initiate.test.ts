import { beforeAll, beforeEach, expect, test } from "vitest";
import prisma from "@/lib/prisma";
import { migrateTestDb, resetDb } from "../../../tests/helpers/db";
import { makeItem, makeUser } from "../../../tests/helpers/factories";
import { initiateTransfer } from "./transfers.service";
import { TransferError } from "./transfers.errors";

beforeAll(() => migrateTestDb());
beforeEach(() => resetDb());

test("holder can initiate a pending transfer to another active user", async () => {
  const admin = await makeUser({ role: "ADMIN" });
  const holder = await makeUser();
  const recipient = await makeUser();
  const item = await makeItem(admin.id, { currentHolderId: holder.id });

  const t = await initiateTransfer({ itemId: item.id, fromUserId: holder.id, toUserId: recipient.id });
  expect(t.status).toBe("PENDING");
  expect(t.toUserId).toBe(recipient.id);
  expect(t.fromUserId).toBe(holder.id);
});

test("non-holder cannot initiate", async () => {
  const admin = await makeUser({ role: "ADMIN" });
  const holder = await makeUser();
  const stranger = await makeUser();
  const recipient = await makeUser();
  const item = await makeItem(admin.id, { currentHolderId: holder.id });
  await expect(
    initiateTransfer({ itemId: item.id, fromUserId: stranger.id, toUserId: recipient.id })
  ).rejects.toMatchObject({ code: "NOT_HOLDER" });
});

test("cannot initiate a second pending transfer", async () => {
  const admin = await makeUser({ role: "ADMIN" });
  const holder = await makeUser();
  const r1 = await makeUser();
  const r2 = await makeUser();
  const item = await makeItem(admin.id, { currentHolderId: holder.id });
  await initiateTransfer({ itemId: item.id, fromUserId: holder.id, toUserId: r1.id });
  await expect(
    initiateTransfer({ itemId: item.id, fromUserId: holder.id, toUserId: r2.id })
  ).rejects.toMatchObject({ code: "ALREADY_PENDING" });
});

test("cannot transfer to self", async () => {
  const admin = await makeUser({ role: "ADMIN" });
  const holder = await makeUser();
  const item = await makeItem(admin.id, { currentHolderId: holder.id });
  await expect(
    initiateTransfer({ itemId: item.id, fromUserId: holder.id, toUserId: holder.id })
  ).rejects.toMatchObject({ code: "SAME_USER" });
});

test("cannot transfer a retired item", async () => {
  const admin = await makeUser({ role: "ADMIN" });
  const holder = await makeUser();
  const recipient = await makeUser();
  const item = await makeItem(admin.id, { currentHolderId: holder.id, status: "RETIRED" });
  await expect(
    initiateTransfer({ itemId: item.id, fromUserId: holder.id, toUserId: recipient.id })
  ).rejects.toMatchObject({ code: "ITEM_RETIRED" });
});

test("cannot transfer to inactive recipient", async () => {
  const admin = await makeUser({ role: "ADMIN" });
  const holder = await makeUser();
  const recipient = await makeUser({ isActive: false });
  const item = await makeItem(admin.id, { currentHolderId: holder.id });
  await expect(
    initiateTransfer({ itemId: item.id, fromUserId: holder.id, toUserId: recipient.id })
  ).rejects.toMatchObject({ code: "RECIPIENT_INVALID" });
});

test("concurrent initiates for the same item: exactly one wins, loser gets ALREADY_PENDING (not a raw Prisma error)", async () => {
  const admin = await makeUser({ role: "ADMIN" });
  const holder = await makeUser();
  const r1 = await makeUser();
  const r2 = await makeUser();
  const item = await makeItem(admin.id, { currentHolderId: holder.id });

  const results = await Promise.allSettled([
    initiateTransfer({ itemId: item.id, fromUserId: holder.id, toUserId: r1.id }),
    initiateTransfer({ itemId: item.id, fromUserId: holder.id, toUserId: r2.id }),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");

  expect(fulfilled).toHaveLength(1);
  expect(rejected).toHaveLength(1);

  // No raw Prisma error should ever leak out of initiateTransfer — every
  // rejection must be a friendly TransferError. In practice this race
  // deterministically resolves to ALREADY_PENDING, but we keep the
  // "no raw Prisma error" assertion authoritative even if timing varies.
  for (const r of rejected) {
    if (r.status !== "rejected") continue;
    expect(r.reason).toBeInstanceOf(TransferError);
    expect((r.reason as TransferError).code).toBe("ALREADY_PENDING");
  }

  const pendingTransfers = await prisma.transfer.findMany({
    where: { itemId: item.id, status: "PENDING" },
  });
  expect(pendingTransfers).toHaveLength(1);
});
