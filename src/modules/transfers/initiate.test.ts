import { beforeAll, beforeEach, expect, test } from "vitest";
import { migrateTestDb, resetDb } from "../../../tests/helpers/db";
import { makeItem, makeUser } from "../../../tests/helpers/factories";
import { initiateTransfer } from "./transfers.service";

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
