import { beforeEach, expect, test } from "vitest";
import prisma from "@/lib/prisma";
import { resetDb } from "../../../tests/helpers/db";
import {
  createItem,
  markItemsReady,
  clearItemsReady,
  setItemsStatus,
  setItemsCategory,
  setItemStatus,
  MAX_BULK_ITEMS,
} from "./items.service";

/* Bulk readiness + category service functions.
 *
 * These write the REAL signals readiness is derived from — there is no stored
 * readiness column and these tests deliberately never assert one exists. */

let adminId: string;
const base = { deviceName: "Radio", homeUnit: undefined, notes: undefined } as const;
const editor = () => ({ id: adminId, name: "Admin" });

beforeEach(async () => {
  await resetDb();
  const admin = await prisma.user.create({
    data: { name: "Admin", email: "a@x.co", passwordHash: "x", role: "ADMIN" },
  });
  adminId = admin.id;
});

async function makeItem(serial: string, deviceCategory?: string) {
  const item = await createItem({ make: "M", model: "N", serialNumber: serial, ...base }, adminId);
  if (deviceCategory) {
    await prisma.item.update({ where: { id: item.id }, data: { deviceCategory } });
  }
  return item;
}

/* ---------------------------------------------------------------- clearItemsReady */

test("clearItemsReady nulls markedReadyAt — the exact inverse of markItemsReady", async () => {
  const a = await makeItem("S1");
  const b = await makeItem("S2");
  await markItemsReady([a.id, b.id]);
  expect((await prisma.item.findUniqueOrThrow({ where: { id: a.id } })).markedReadyAt).not.toBeNull();

  const res = await clearItemsReady([a.id, b.id]);
  expect(res.updated).toBe(2);
  for (const id of [a.id, b.id]) {
    expect((await prisma.item.findUniqueOrThrow({ where: { id } })).markedReadyAt).toBeNull();
  }
});

test("clearItemsReady counts only rows that actually held a stamp", async () => {
  const marked = await makeItem("S1");
  const never = await makeItem("S2");
  await markItemsReady([marked.id]);

  const res = await clearItemsReady([marked.id, never.id]);
  expect(res.updated).toBe(1);
});

test("clearItemsReady DOES reach retired items (markItemsReady does not)", async () => {
  const item = await makeItem("S1");
  await markItemsReady([item.id]);
  await setItemStatus(item.id, "RETIRED");

  // Retracting a stale claim must not be blocked by the lifecycle status, or a
  // reactivated device would come back reading "Ready to deploy" off a marking
  // nobody re-checked.
  const res = await clearItemsReady([item.id]);
  expect(res.updated).toBe(1);
  expect((await prisma.item.findUniqueOrThrow({ where: { id: item.id } })).markedReadyAt).toBeNull();
});

test("markItemsReady still SKIPS retired items — the asymmetry is intentional", async () => {
  const item = await makeItem("S1");
  await setItemStatus(item.id, "RETIRED");
  expect((await markItemsReady([item.id])).updated).toBe(0);
});

test("clearItemsReady dedupes ids and no-ops on an empty list", async () => {
  const item = await makeItem("S1");
  await markItemsReady([item.id]);
  expect((await clearItemsReady([item.id, item.id, "", "  "])).updated).toBe(1);
  expect((await clearItemsReady([])).updated).toBe(0);
});

test("clearItemsReady refuses more than MAX_BULK_ITEMS", async () => {
  const ids = Array.from({ length: MAX_BULK_ITEMS + 1 }, (_, i) => `id-${i}`);
  await expect(clearItemsReady(ids)).rejects.toMatchObject({ code: "TOO_MANY" });
});

/* ----------------------------------------------------------------- setItemsStatus */

test("setItemsStatus retires and reactivates in bulk", async () => {
  const a = await makeItem("S1");
  const b = await makeItem("S2");

  expect((await setItemsStatus([a.id, b.id], "RETIRED")).updated).toBe(2);
  expect(await prisma.item.count({ where: { status: "RETIRED" } })).toBe(2);

  expect((await setItemsStatus([a.id, b.id], "ACTIVE")).updated).toBe(2);
  expect(await prisma.item.count({ where: { status: "ACTIVE" } })).toBe(2);
});

test("setItemsStatus counts only rows that changed", async () => {
  const already = await makeItem("S1");
  const active = await makeItem("S2");
  await setItemStatus(already.id, "RETIRED");

  expect((await setItemsStatus([already.id, active.id], "RETIRED")).updated).toBe(1);
});

test("setItemsStatus writes no ItemEdit (status is not a logged field)", async () => {
  const item = await makeItem("S1");
  await setItemsStatus([item.id], "RETIRED");
  expect(await prisma.itemEdit.count()).toBe(0);
});

test("setItemsStatus dedupes, no-ops on empty, and refuses over the cap", async () => {
  const item = await makeItem("S1");
  expect((await setItemsStatus([item.id, item.id, ""], "RETIRED")).updated).toBe(1);
  expect((await setItemsStatus([], "ACTIVE")).updated).toBe(0);
  await expect(
    setItemsStatus(Array.from({ length: MAX_BULK_ITEMS + 1 }, (_, i) => `id-${i}`), "RETIRED"),
  ).rejects.toMatchObject({ code: "TOO_MANY" });
});

/* --------------------------------------------------------------- setItemsCategory */

test("setItemsCategory assigns the category and logs ONE ItemEdit per changed item", async () => {
  const a = await makeItem("S1");
  const b = await makeItem("S2");

  const res = await setItemsCategory([a.id, b.id], "Laptops", editor());
  expect(res).toEqual({ updated: 2, unchanged: 0 });

  for (const id of [a.id, b.id]) {
    expect((await prisma.item.findUniqueOrThrow({ where: { id } })).deviceCategory).toBe("Laptops");
  }

  const edits = await prisma.itemEdit.findMany();
  expect(edits).toHaveLength(2);
  expect(edits[0].editedById).toBe(adminId);
  expect(edits[0].editedByName).toBe("Admin");
  // Identical in shape to a single-item edit's diff (diffItemFields).
  expect(edits[0].changes).toEqual([{ field: "deviceCategory", from: null, to: "Laptops" }]);
});

test("setItemsCategory records the previous value in the diff", async () => {
  const item = await makeItem("S1", "Tablets");
  await setItemsCategory([item.id], "Laptops", editor());
  const edit = await prisma.itemEdit.findFirstOrThrow({ where: { itemId: item.id } });
  expect(edit.changes).toEqual([{ field: "deviceCategory", from: "Tablets", to: "Laptops" }]);
});

test("setItemsCategory writes NO history row for items already holding the value", async () => {
  const changed = await makeItem("S1", "Tablets");
  const same = await makeItem("S2", "Laptops");

  const res = await setItemsCategory([changed.id, same.id], "Laptops", editor());
  expect(res).toEqual({ updated: 1, unchanged: 1 });

  expect(await prisma.itemEdit.count({ where: { itemId: same.id } })).toBe(0);
  expect(await prisma.itemEdit.count({ where: { itemId: changed.id } })).toBe(1);
});

test("setItemsCategory is a full no-op when nothing differs", async () => {
  const item = await makeItem("S1", "Laptops");
  const res = await setItemsCategory([item.id], "Laptops", editor());
  expect(res).toEqual({ updated: 0, unchanged: 1 });
  expect(await prisma.itemEdit.count()).toBe(0);
});

test("setItemsCategory normalizes the name before storing it", async () => {
  const item = await makeItem("S1");
  await setItemsCategory([item.id], "  Field   Radios  ", editor());
  expect((await prisma.item.findUniqueOrThrow({ where: { id: item.id } })).deviceCategory).toBe(
    "Field Radios",
  );
});

test("setItemsCategory registers the name in the managed vocabulary", async () => {
  const item = await makeItem("S1");
  await setItemsCategory([item.id], "Laptops", editor());
  expect(await prisma.deviceCategory.count({ where: { name: "Laptops" } })).toBe(1);

  // Re-running must not duplicate the vocabulary row (createMany skipDuplicates).
  const other = await makeItem("S2");
  await setItemsCategory([other.id], "Laptops", editor());
  expect(await prisma.deviceCategory.count({ where: { name: "Laptops" } })).toBe(1);
});

test("setItemsCategory reaches retired items — re-categorizing is data cleanup", async () => {
  const item = await makeItem("S1");
  await setItemStatus(item.id, "RETIRED");
  expect((await setItemsCategory([item.id], "Laptops", editor())).updated).toBe(1);
});

test("setItemsCategory rejects a blank category", async () => {
  const item = await makeItem("S1");
  await expect(setItemsCategory([item.id], "   ", editor())).rejects.toMatchObject({
    code: "INVALID",
  });
});

test("setItemsCategory dedupes ids, no-ops on empty, and refuses over the cap", async () => {
  const item = await makeItem("S1");
  const res = await setItemsCategory([item.id, item.id, ""], "Laptops", editor());
  expect(res).toEqual({ updated: 1, unchanged: 0 });

  expect(await setItemsCategory([], "Laptops", editor())).toEqual({ updated: 0, unchanged: 0 });

  await expect(
    setItemsCategory(Array.from({ length: MAX_BULK_ITEMS + 1 }, (_, i) => `id-${i}`), "Laptops", editor()),
  ).rejects.toMatchObject({ code: "TOO_MANY" });
});
