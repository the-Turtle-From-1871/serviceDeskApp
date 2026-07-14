import { beforeAll, beforeEach, expect, test } from "vitest";
import prisma from "@/lib/prisma";
import { resetDb, migrateTestDb } from "../../../tests/helpers/db";
import { createItem, analyzeImport, commitImport } from "./items.service";

let adminId: string;
beforeAll(() => migrateTestDb());
beforeEach(async () => {
  await resetDb();
  const admin = await prisma.user.create({ data: { name: "Admin", email: "a@x.co", passwordHash: "x", role: "ADMIN" } });
  adminId = admin.id;
});

test("commitImport imports valid rows, skips DB/in-file duplicates and invalid rows", async () => {
  await createItem({ make: "Dell", model: "5540", serialNumber: "EXIST1", deviceName: "Radio", homeUnit: undefined, notes: undefined }, adminId);

  const csv = [
    "make,model,serialNumber,deviceName,homeUnit,notes",
    "M4,Carbine,NEW1,Radio,A Co,tan",   // ok (explicit homeUnit)
    "M4,Carbine,EXIST1,Radio,,",         // already exists
    "PVS,14,DUP1,Radio,,",               // ok (first)
    "PVS,14,DUP1,Radio,,",               // duplicate in file
    ",Carbine,BAD1,Radio,,",             // invalid (missing make)
  ].join("\n");

  const res = await commitImport(csv, "items.csv", [], adminId);

  expect(res.error).toBeUndefined();
  expect(res.added).toBe(2);
  expect(res.skipped).toHaveLength(3);
  expect(res.skipped.map((s) => s.reason).sort()).toEqual(["Make is required", "already exists", "duplicate in file"].sort());

  expect(await prisma.item.count()).toBe(3);
  const serials = (await prisma.item.findMany({ select: { serialNumber: true } })).map((i) => i.serialNumber).sort();
  expect(serials).toEqual(["DUP1", "EXIST1", "NEW1"]);

  const batch = await prisma.importBatch.findFirst();
  expect(batch).toMatchObject({ filename: "items.csv", addedCount: 2, skippedCount: 3, createdById: adminId });
  expect(Array.isArray(batch!.skipped)).toBe(true);
});

test("commitImport returns a format error and imports nothing when headers are missing", async () => {
  const res = await commitImport("make,model\nM4,Carbine\n", "bad.csv", [], adminId);
  expect(res.added).toBe(0);
  expect(res.error).toMatch(/serialNumber/);
  expect(await prisma.item.count()).toBe(0);
  expect(await prisma.importBatch.count()).toBe(0);
});

test("analyzeImport auto-detects seeded units and lists unresolved device names", async () => {
  await prisma.unit.create({ data: { abbreviation: "DCSIM", fullName: "DCSIM" } });
  const csv = [
    "make,model,serialNumber,deviceName,homeUnit,notes",
    "M4,Carbine,A1,HI-DCSIM-LT-001,,",  // auto-detected
    "M4,Carbine,A2,HI-XYZ-LT-002,,",    // unresolved
  ].join("\n");

  const res = await analyzeImport(csv);

  expect(res.error).toBeUndefined();
  expect(res.counts).toMatchObject({ toImport: 2, skipped: 0, autoDetected: 1 });
  expect(res.unresolved).toEqual([{ row: 2, deviceName: "HI-XYZ-LT-002", segments: ["HI", "XYZ", "LT", "002"] }]);
  // analyze writes nothing
  expect(await prisma.item.count()).toBe(0);
});

test("commitImport learns a resolution and applies it to every matching row", async () => {
  const csv = [
    "make,model,serialNumber,deviceName,homeUnit,notes",
    "M4,Carbine,A1,HI-XYZ-LT-001,,",
    "M4,Carbine,A2,HI-XYZ-DT-002,,",  // same unknown segment XYZ
  ].join("\n");

  const res = await commitImport(csv, "items.csv", [{ abbreviation: "XYZ", fullName: "456th Signal Co" }], adminId);

  expect(res.added).toBe(2);
  expect(res.detected).toBe(2); // both rows filled from the newly-learned unit
  const homeUnits = (await prisma.item.findMany({ select: { homeUnit: true } })).map((i) => i.homeUnit);
  expect(homeUnits).toEqual(["456th Signal Co", "456th Signal Co"]);
  // the unit persisted for future imports
  expect(await prisma.unit.findUnique({ where: { abbreviation: "XYZ" } })).toBeTruthy();
});
