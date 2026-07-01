import { beforeAll, beforeEach, expect, test } from "vitest";
import prisma from "@/lib/prisma";
import { migrateTestDb, resetDb } from "../../../tests/helpers/db";
import { makeItem, makeUser } from "../../../tests/helpers/factories";
import { initiateTransfer, acceptTransfer, cancelTransfer, overrideAssign, assignInitialHolder } from "./transfers.service";

const SIG = "data:image/png;base64,iVBORw0KGgoAAAANS";

beforeAll(() => migrateTestDb());
beforeEach(() => resetDb());

test("recipient accepts with signature → custody moves and receipt completes", async () => {
  const admin = await makeUser({ role: "ADMIN" });
  const holder = await makeUser();
  const recipient = await makeUser();
  const item = await makeItem(admin.id, { currentHolderId: holder.id });
  const t = await initiateTransfer({ itemId: item.id, fromUserId: holder.id, toUserId: recipient.id });

  const done = await acceptTransfer({ transferId: t.id, toUserId: recipient.id, signatureImage: SIG });
  expect(done.status).toBe("COMPLETED");
  expect(done.signedAt).not.toBeNull();
  const after = await prisma.item.findUnique({ where: { id: item.id } });
  expect(after?.currentHolderId).toBe(recipient.id);
});

test("accept requires a signature", async () => {
  const admin = await makeUser({ role: "ADMIN" });
  const holder = await makeUser();
  const recipient = await makeUser();
  const item = await makeItem(admin.id, { currentHolderId: holder.id });
  const t = await initiateTransfer({ itemId: item.id, fromUserId: holder.id, toUserId: recipient.id });
  await expect(
    acceptTransfer({ transferId: t.id, toUserId: recipient.id, signatureImage: "" })
  ).rejects.toMatchObject({ code: "SIGNATURE_REQUIRED" });
});

test("only the recipient can accept", async () => {
  const admin = await makeUser({ role: "ADMIN" });
  const holder = await makeUser();
  const recipient = await makeUser();
  const stranger = await makeUser();
  const item = await makeItem(admin.id, { currentHolderId: holder.id });
  const t = await initiateTransfer({ itemId: item.id, fromUserId: holder.id, toUserId: recipient.id });
  await expect(
    acceptTransfer({ transferId: t.id, toUserId: stranger.id, signatureImage: SIG })
  ).rejects.toMatchObject({ code: "NOT_RECIPIENT" });
});

test("initiating holder can cancel a pending transfer", async () => {
  const admin = await makeUser({ role: "ADMIN" });
  const holder = await makeUser();
  const recipient = await makeUser();
  const item = await makeItem(admin.id, { currentHolderId: holder.id });
  const t = await initiateTransfer({ itemId: item.id, fromUserId: holder.id, toUserId: recipient.id });
  const cancelled = await cancelTransfer({ transferId: t.id, actingUserId: holder.id, isAdmin: false });
  expect(cancelled.status).toBe("CANCELLED");
  const after = await prisma.item.findUnique({ where: { id: item.id } });
  expect(after?.currentHolderId).toBe(holder.id); // unchanged
});

test("a stranger cannot cancel", async () => {
  const admin = await makeUser({ role: "ADMIN" });
  const holder = await makeUser();
  const recipient = await makeUser();
  const stranger = await makeUser();
  const item = await makeItem(admin.id, { currentHolderId: holder.id });
  const t = await initiateTransfer({ itemId: item.id, fromUserId: holder.id, toUserId: recipient.id });
  await expect(
    cancelTransfer({ transferId: t.id, actingUserId: stranger.id, isAdmin: false })
  ).rejects.toMatchObject({ code: "NOT_HOLDER" });
});

test("admin override moves custody without signature and cancels pending", async () => {
  const admin = await makeUser({ role: "ADMIN" });
  const holder = await makeUser();
  const recipient = await makeUser();
  const target = await makeUser();
  const item = await makeItem(admin.id, { currentHolderId: holder.id });
  const pending = await initiateTransfer({ itemId: item.id, fromUserId: holder.id, toUserId: recipient.id });

  const ov = await overrideAssign({ itemId: item.id, toUserId: target.id, actingAdminId: admin.id });
  expect(ov.isOverride).toBe(true);
  expect(ov.status).toBe("COMPLETED");
  const after = await prisma.item.findUnique({ where: { id: item.id } });
  expect(after?.currentHolderId).toBe(target.id);
  const stale = await prisma.transfer.findUnique({ where: { id: pending.id } });
  expect(stale?.status).toBe("CANCELLED");
});

test("override rejects a no-op reassign to the current holder", async () => {
  const admin = await makeUser({ role: "ADMIN" });
  const holder = await makeUser();
  const item = await makeItem(admin.id, { currentHolderId: holder.id });
  await expect(
    overrideAssign({ itemId: item.id, toUserId: holder.id, actingAdminId: admin.id })
  ).rejects.toMatchObject({ code: "SAME_USER" });
});

test("assignInitialHolder records a fromUser-null completed assignment and sets holder", async () => {
  const admin = await makeUser({ role: "ADMIN" });
  const recipient = await makeUser();
  const item = await makeItem(admin.id); // unassigned

  const t = await assignInitialHolder({ itemId: item.id, toUserId: recipient.id });
  expect(t.status).toBe("COMPLETED");
  expect(t.fromUserId).toBeNull();
  expect(t.toUserId).toBe(recipient.id);
  expect(t.signedAt).not.toBeNull();
  const after = await prisma.item.findUnique({ where: { id: item.id } });
  expect(after?.currentHolderId).toBe(recipient.id);
});

test("assignInitialHolder refuses an item that already has a holder", async () => {
  const admin = await makeUser({ role: "ADMIN" });
  const holder = await makeUser();
  const other = await makeUser();
  const item = await makeItem(admin.id, { currentHolderId: holder.id });
  await expect(
    assignInitialHolder({ itemId: item.id, toUserId: other.id })
  ).rejects.toMatchObject({ code: "ALREADY_HELD" });
});
