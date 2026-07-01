import { beforeAll, beforeEach, expect, test } from "vitest";
import { migrateTestDb, resetDb } from "../../../tests/helpers/db";
import { makeItem, makeUser } from "../../../tests/helpers/factories";
import { initiateTransfer, getItemHistory, getPendingForUser, getHeldItems } from "./transfers.service";

beforeAll(() => migrateTestDb());
beforeEach(() => resetDb());

test("getHeldItems returns items the user currently holds", async () => {
  const admin = await makeUser({ role: "ADMIN" });
  const holder = await makeUser();
  await makeItem(admin.id, { currentHolderId: holder.id });
  await makeItem(admin.id); // unassigned
  const held = await getHeldItems(holder.id);
  expect(held).toHaveLength(1);
});

test("getPendingForUser splits incoming and outgoing", async () => {
  const admin = await makeUser({ role: "ADMIN" });
  const holder = await makeUser();
  const recipient = await makeUser();
  const item = await makeItem(admin.id, { currentHolderId: holder.id });
  await initiateTransfer({ itemId: item.id, fromUserId: holder.id, toUserId: recipient.id });

  const forRecipient = await getPendingForUser(recipient.id);
  expect(forRecipient.incoming).toHaveLength(1);
  expect(forRecipient.outgoing).toHaveLength(0);

  const forHolder = await getPendingForUser(holder.id);
  expect(forHolder.incoming).toHaveLength(0);
  expect(forHolder.outgoing).toHaveLength(1);
});

test("getItemHistory returns transfers newest first", async () => {
  const admin = await makeUser({ role: "ADMIN" });
  const holder = await makeUser();
  const recipient = await makeUser();
  const item = await makeItem(admin.id, { currentHolderId: holder.id });
  await initiateTransfer({ itemId: item.id, fromUserId: holder.id, toUserId: recipient.id });
  const history = await getItemHistory(item.id);
  expect(history).toHaveLength(1);
});
