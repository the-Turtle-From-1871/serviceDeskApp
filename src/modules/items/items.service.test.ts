import { beforeAll, beforeEach, expect, test } from "vitest";
import prisma from "@/lib/prisma";
import { resetDb, migrateTestDb } from "../../../tests/helpers/db";
import { createItem, getItem, listItems, updateItemFields, retireItem, setItemStatus } from "./items.service";

let adminId: string;
const base = { deviceName: "Radio", homeUnit: undefined, notes: undefined } as const;

beforeAll(() => migrateTestDb());
beforeEach(async () => {
  await resetDb();
  const admin = await prisma.user.create({
    data: { name: "Admin", email: "a@x.co", passwordHash: "x", role: "ADMIN" },
  });
  adminId = admin.id;
});

test("createItem persists required fields and defaults", async () => {
  const item = await createItem(
    { make: "Dell", model: "5540", serialNumber: "SN1", ...base },
    adminId
  );
  expect(item.make).toBe("Dell");
  expect(item.status).toBe("ACTIVE");
  expect(item.createdById).toBe(adminId);
});

test("createItem rejects blank serial number", async () => {
  await expect(
    createItem({ make: "Dell", model: "5540", serialNumber: "   ", ...base }, adminId)
  ).rejects.toThrow();
});

test("createItem rejects a blank device name", async () => {
  await expect(
    createItem({ make: "Dell", model: "5540", serialNumber: "SN1", ...base, deviceName: "" }, adminId)
  ).rejects.toThrow();
});

test("getItem returns the item by id", async () => {
  const created = await createItem({ make: "M", model: "N", serialNumber: "S", ...base }, adminId);
  const found = await getItem(created.id);
  expect(found?.id).toBe(created.id);
});

test("listItems search matches serial number", async () => {
  await createItem({ make: "Dell", model: "A", serialNumber: "ABC123", ...base }, adminId);
  await createItem({ make: "HP", model: "B", serialNumber: "ZZZ999", ...base }, adminId);
  const results = await listItems({ search: "ABC" });
  expect(results).toHaveLength(1);
  expect(results[0].serialNumber).toBe("ABC123");
});

test("retireItem sets status RETIRED", async () => {
  const item = await createItem({ make: "M", model: "N", serialNumber: "S", ...base }, adminId);
  const retired = await retireItem(item.id);
  expect(retired.status).toBe("RETIRED");
});

test("updateItemFields changes fields and records one ItemEdit with the diff", async () => {
  const item = await createItem({ make: "M", model: "N", serialNumber: "S", ...base }, adminId);
  const updated = await updateItemFields(
    item.id,
    { homeUnit: "Cage 3", currentUser: "SGT Smith", currentPosition: "Supply Sergeant" },
    { id: adminId, name: "Admin" },
  );
  expect(updated.homeUnit).toBe("Cage 3");
  expect(updated.currentUser).toBe("SGT Smith");
  expect(updated.currentPosition).toBe("Supply Sergeant");

  const edits = await prisma.itemEdit.findMany({ where: { itemId: item.id } });
  expect(edits).toHaveLength(1);
  expect(edits[0].editedById).toBe(adminId);
  expect(edits[0].editedByName).toBe("Admin");
  expect(edits[0].changes).toEqual([
    { field: "homeUnit", from: null, to: "Cage 3" },
    { field: "currentUser", from: null, to: "SGT Smith" },
    { field: "currentPosition", from: null, to: "Supply Sergeant" },
  ]);
});

test("updateItemFields writes no history row for a no-op save", async () => {
  const item = await createItem({ make: "M", model: "N", serialNumber: "S", ...base }, adminId);
  await updateItemFields(item.id, { deviceName: "Radio" }, { id: adminId, name: "Admin" });
  expect(await prisma.itemEdit.count({ where: { itemId: item.id } })).toBe(0);
});

test("updateItemFields records only the fields that changed", async () => {
  const item = await createItem({ make: "M", model: "N", serialNumber: "S", ...base }, adminId);
  await updateItemFields(item.id, { deviceName: "Radio", currentUser: "SPC Lin" }, { id: adminId, name: "Admin" });
  const edit = await prisma.itemEdit.findFirstOrThrow({ where: { itemId: item.id } });
  expect(edit.changes).toEqual([{ field: "currentUser", from: null, to: "SPC Lin" }]);
});

test("updateItemFields clears a field when given a blank value", async () => {
  const item = await createItem({ make: "M", model: "N", serialNumber: "S", ...base }, adminId);
  await updateItemFields(item.id, { currentUser: "SPC Lin" }, { id: adminId, name: "Admin" });
  const cleared = await updateItemFields(item.id, { currentUser: "" }, { id: adminId, name: "Admin" });
  expect(cleared.currentUser).toBeNull();
});

test("updateItemFields throws NOT_FOUND for a missing item", async () => {
  await expect(
    updateItemFields("nope", { currentUser: "X" }, { id: adminId, name: "Admin" }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("setItemStatus can retire then reactivate", async () => {
  const item = await createItem({ make: "M", model: "N", serialNumber: "S", ...base }, adminId);
  expect((await setItemStatus(item.id, "RETIRED")).status).toBe("RETIRED");
  expect((await setItemStatus(item.id, "ACTIVE")).status).toBe("ACTIVE");
});
