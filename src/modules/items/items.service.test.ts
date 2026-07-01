import { beforeAll, beforeEach, expect, test } from "vitest";
import prisma from "@/lib/prisma";
import { resetDb, migrateTestDb } from "../../../tests/helpers/db";
import { createItem, getItem, listItems, updateItem, retireItem, setItemStatus } from "./items.service";

let adminId: string;

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
    { make: "Dell", model: "5540", serialNumber: "SN1" },
    adminId
  );
  expect(item.make).toBe("Dell");
  expect(item.status).toBe("ACTIVE");
  expect(item.currentHolderId).toBeNull();
  expect(item.createdById).toBe(adminId);
});

test("createItem rejects blank serial number", async () => {
  await expect(
    createItem({ make: "Dell", model: "5540", serialNumber: "   " }, adminId)
  ).rejects.toThrow();
});

test("getItem includes current holder relation", async () => {
  const created = await createItem({ make: "M", model: "N", serialNumber: "S" }, adminId);
  const found = await getItem(created.id);
  expect(found?.id).toBe(created.id);
  expect(found).toHaveProperty("currentHolder");
});

test("listItems search matches serial number", async () => {
  await createItem({ make: "Dell", model: "A", serialNumber: "ABC123" }, adminId);
  await createItem({ make: "HP", model: "B", serialNumber: "ZZZ999" }, adminId);
  const results = await listItems({ search: "ABC" });
  expect(results).toHaveLength(1);
  expect(results[0].serialNumber).toBe("ABC123");
});

test("retireItem sets status RETIRED", async () => {
  const item = await createItem({ make: "M", model: "N", serialNumber: "S" }, adminId);
  const retired = await retireItem(item.id);
  expect(retired.status).toBe("RETIRED");
});

test("updateItem changes editable fields", async () => {
  const item = await createItem({ make: "M", model: "N", serialNumber: "S" }, adminId);
  const updated = await updateItem(item.id, { homeLocation: "Cage 3" });
  expect(updated.homeLocation).toBe("Cage 3");
});

test("setItemStatus can retire then reactivate", async () => {
  const item = await createItem({ make: "M", model: "N", serialNumber: "S" }, adminId);
  expect((await setItemStatus(item.id, "RETIRED")).status).toBe("RETIRED");
  expect((await setItemStatus(item.id, "ACTIVE")).status).toBe("ACTIVE");
});
