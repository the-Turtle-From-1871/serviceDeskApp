import { beforeAll, beforeEach, expect, test } from "vitest";
import prisma from "@/lib/prisma";
import { resetDb, migrateTestDb } from "../../../tests/helpers/db";
import { createItem, importItems } from "./items.service";

let adminId: string;
beforeAll(() => migrateTestDb());
beforeEach(async () => {
  await resetDb();
  const admin = await prisma.user.create({ data: { name: "Admin", email: "a@x.co", passwordHash: "x", role: "ADMIN" } });
  adminId = admin.id;
});

test("imports valid rows, skips DB duplicates, in-file duplicates, and invalid rows", async () => {
  await createItem({ make: "Dell", model: "5540", serialNumber: "EXIST1", homeUnit: undefined, notes: undefined }, adminId);

  const csv = [
    "make,model,serialNumber,homeUnit,notes",
    "M4,Carbine,NEW1,A Co,tan",   // ok
    "M4,Carbine,EXIST1,,",         // already exists
    "PVS,14,DUP1,,",               // ok (first)
    "PVS,14,DUP1,,",               // duplicate in file
    ",Carbine,BAD1,,",             // invalid (missing make)
  ].join("\n");

  const res = await importItems(csv, "items.csv", adminId);

  expect(res.error).toBeUndefined();
  expect(res.added).toBe(2);
  expect(res.skipped).toHaveLength(3);
  expect(res.skipped.map((s) => s.reason).sort()).toEqual(["already exists", "duplicate in file", "Make is required"].sort());

  // Two new items landed (plus the pre-existing EXIST1 = 3 total).
  expect(await prisma.item.count()).toBe(3);
  const serials = (await prisma.item.findMany({ select: { serialNumber: true } })).map((i) => i.serialNumber).sort();
  expect(serials).toEqual(["DUP1", "EXIST1", "NEW1"]);

  // An audit record was written with the counts and skipped detail.
  const batch = await prisma.importBatch.findFirst();
  expect(batch).toMatchObject({ filename: "items.csv", addedCount: 2, skippedCount: 3, createdById: adminId });
  expect(Array.isArray(batch!.skipped)).toBe(true);
});

test("returns a format error and imports nothing when headers are missing", async () => {
  const res = await importItems("make,model\nM4,Carbine\n", "bad.csv", adminId);
  expect(res.added).toBe(0);
  expect(res.error).toMatch(/serialNumber/);
  expect(await prisma.item.count()).toBe(0);
  expect(await prisma.importBatch.count()).toBe(0);
});
