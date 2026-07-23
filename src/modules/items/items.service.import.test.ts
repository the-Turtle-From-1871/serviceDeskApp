import { beforeAll, beforeEach, expect, test } from "vitest";
import prisma from "@/lib/prisma";
import { resetDb, migrateTestDb } from "../../../tests/helpers/db";
import { createItem, analyzeImport, commitImport } from "./items.service";

let admin: { id: string; name: string };
beforeAll(() => migrateTestDb());
beforeEach(async () => {
  await resetDb();
  const a = await prisma.user.create({ data: { name: "Admin", email: "a@x.co", passwordHash: "x", role: "ADMIN" } });
  admin = { id: a.id, name: a.name };
});

test("commitImport creates new rows, updates matches, and reports unchanged", async () => {
  await createItem({ make: "Dell", model: "5540", serialNumber: "EXIST1", deviceName: "Radio", homeUnit: undefined, notes: undefined }, admin.id);

  const csv = [
    "make,model,serialNumber,deviceName,assignedUser,compliance",
    "M4,Carbine,NEW1,Radio,,",              // create
    "Dell,5540,EXIST1,Radio,,",             // unchanged (all equal)
    "PVS,14,DUP1,Radio,,",                  // create (first)
    "PVS,14,DUP1,Radio,,",                  // duplicate in file
    ",Carbine,BAD1,Radio,,",                // new row missing make -> skipped
  ].join("\n");

  const res = await commitImport(csv, "items.csv", [], admin);

  expect(res.error).toBeUndefined();
  expect(res.added).toBe(2);            // NEW1, DUP1
  expect(res.updated).toBe(0);
  expect(res.unchanged).toBe(1);        // EXIST1
  expect(res.skipped.map((s) => s.reason).sort()).toEqual(
    ["duplicate in file", "make and model are required for new items"].sort(),
  );
  expect(await prisma.item.count()).toBe(3);

  const batch = await prisma.importBatch.findFirst();
  expect(batch).toMatchObject({ addedCount: 2, updatedCount: 0, createdById: admin.id });
});

test("commitImport updates deviceName + assignedUser (logged) and telemetry (silent)", async () => {
  await createItem({ make: "Dell", model: "5540", serialNumber: "UP1", deviceName: "Old", homeUnit: undefined, notes: undefined }, admin.id);

  const csv = [
    "serialNumber,deviceName,assignedUser,lastLogonDate,compliance",
    "UP1,NewName,jane@x.mil,2026-07-01,Compliant",
  ].join("\n");

  const res = await commitImport(csv, "items.csv", [], admin);
  expect(res.added).toBe(0);
  expect(res.updated).toBe(1);

  const item = await prisma.item.findUniqueOrThrow({ where: { serialNumber: "UP1" } });
  expect(item.deviceName).toBe("NewName");
  expect(item.currentUserEmail).toBe("jane@x.mil");
  expect(item.lastLogonDate).toBe("2026-07-01");
  expect(item.compliance).toBe("Compliant");

  // Exactly one ItemEdit, covering only the two logged fields (not telemetry).
  const edits = await prisma.itemEdit.findMany({ where: { itemId: item.id } });
  expect(edits).toHaveLength(1);
  const fields = (edits[0].changes as { field: string }[]).map((c) => c.field).sort();
  expect(fields).toEqual(["currentUserEmail", "deviceName"]);
});

test("commitImport telemetry-only change writes no ItemEdit", async () => {
  await createItem({ make: "Dell", model: "5540", serialNumber: "UP2", deviceName: "Same", homeUnit: undefined, notes: undefined }, admin.id);
  const csv = "serialNumber,deviceName,compliance\nUP2,Same,Noncompliant\n";
  const res = await commitImport(csv, "items.csv", [], admin);
  expect(res.updated).toBe(1);
  const item = await prisma.item.findUniqueOrThrow({ where: { serialNumber: "UP2" } });
  expect(item.compliance).toBe("Noncompliant");
  expect(await prisma.itemEdit.count({ where: { itemId: item.id } })).toBe(0);
});

test("analyzeImport reports mismatches and update counts without writing", async () => {
  await createItem({ make: "Dell", model: "5540", serialNumber: "M1", deviceName: "Old", homeUnit: undefined, notes: undefined }, admin.id);
  const csv = "make,model,serialNumber,deviceName\nHP,x360,M1,New\n"; // make/model differ, deviceName differs
  const res = await analyzeImport(csv);
  expect(res.error).toBeUndefined();
  expect(res.counts).toMatchObject({ toImport: 0, toUpdate: 1, unchanged: 0 });
  expect(res.mismatches).toEqual([{ serialNumber: "M1" }]);
  expect(await prisma.itemEdit.count()).toBe(0); // analyze writes nothing
});

test("commitImport returns a format error and imports nothing when serial column missing", async () => {
  const res = await commitImport("make,model\nM4,Carbine\n", "bad.csv", [], admin);
  expect(res.added).toBe(0);
  expect(res.error).toMatch(/serialNumber/);
  expect(await prisma.item.count()).toBe(0);
  expect(await prisma.importBatch.count()).toBe(0);
});

test("commitImport learns a resolution and applies it to every matching new row", async () => {
  const csv = [
    "make,model,serialNumber,deviceName,homeUnit,notes",
    "M4,Carbine,A1,HI-XYZ-LT-001,,",
    "M4,Carbine,A2,HI-XYZ-DT-002,,",
  ].join("\n");
  const res = await commitImport(csv, "items.csv", [{ abbreviation: "XYZ", fullName: "456th Signal Co" }], admin);
  expect(res.added).toBe(2);
  expect(res.detected).toBe(2);
  const homeUnits = (await prisma.item.findMany({ select: { homeUnit: true } })).map((i) => i.homeUnit);
  expect(homeUnits).toEqual(["456th Signal Co", "456th Signal Co"]);
});
