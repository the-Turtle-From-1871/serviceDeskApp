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
    "serialNumber,deviceName,deviceUIC,assignedUser,lastLogonDate,compliance",
    "UP1,NewName,WABC00,jane@x.mil,2026-07-01,Compliant",
  ].join("\n");

  const res = await commitImport(csv, "items.csv", [], admin);
  expect(res.added).toBe(0);
  expect(res.updated).toBe(1);

  const item = await prisma.item.findUniqueOrThrow({ where: { serialNumber: "UP1" } });
  expect(item.deviceName).toBe("NewName");
  expect(item.deviceUIC).toBe("WABC00");
  expect(item.currentUserEmail).toBe("jane@x.mil");
  expect(item.lastLogonDate).toBe("2026-07-01");
  expect(item.compliance).toBe("Compliant");

  // Exactly one ItemEdit, covering only the logged fields (deviceName, deviceUIC,
  // currentUserEmail) — not the silently-updated telemetry.
  const edits = await prisma.itemEdit.findMany({ where: { itemId: item.id } });
  expect(edits).toHaveLength(1);
  const fields = (edits[0].changes as { field: string }[]).map((c) => c.field).sort();
  expect(fields).toEqual(["currentUserEmail", "deviceName", "deviceUIC"]);
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

test("commitImport updates a RETIRED item's fields but writes no ItemEdit", async () => {
  await createItem({ make: "Dell", model: "5540", serialNumber: "RET1", deviceName: "Old", homeUnit: undefined, notes: undefined }, admin.id);
  await prisma.item.update({ where: { serialNumber: "RET1" }, data: { status: "RETIRED" } });

  const csv = "serialNumber,deviceName,assignedUser,compliance\nRET1,NewName,jane@x.mil,Compliant\n";
  const res = await commitImport(csv, "items.csv", [], admin);
  expect(res.updated).toBe(1); // the update still happens

  const item = await prisma.item.findUniqueOrThrow({ where: { serialNumber: "RET1" } });
  expect(item.deviceName).toBe("NewName");
  expect(item.currentUserEmail).toBe("jane@x.mil");
  expect(item.compliance).toBe("Compliant");
  expect(item.status).toBe("RETIRED");
  // No history row for a retired item, even though deviceName/assignedUser changed.
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

test("commitImport overwrites an existing item's homeUnit from the CSV and logs the change", async () => {
  await createItem({ make: "Dell", model: "5540", serialNumber: "HU1", deviceName: "Radio", homeUnit: "Old Unit", notes: undefined }, admin.id);

  const csv = "serialNumber,deviceName,homeUnit\nHU1,Radio,New Unit\n";
  const res = await commitImport(csv, "items.csv", [], admin);
  expect(res.updated).toBe(1);

  const item = await prisma.item.findUniqueOrThrow({ where: { serialNumber: "HU1" } });
  expect(item.homeUnit).toBe("New Unit");

  const edits = await prisma.itemEdit.findMany({ where: { itemId: item.id } });
  expect(edits).toHaveLength(1);
  expect(edits[0].changes).toEqual([{ field: "homeUnit", from: "Old Unit", to: "New Unit" }]);
});

test("commitImport reports rows whose home unit could not be derived", async () => {
  // A device name with no segment matching any known unit abbreviation, and no
  // homeUnit column -> unresolved, but the row still imports.
  const csv = [
    "serialNumber,make,model,deviceName",
    "UNRESOLVED-1,Dell,7440,ZZTOP99-LT-001",
  ].join("\n");

  const res = await commitImport(csv, "fleet.csv", [], admin);

  expect(res.added).toBe(1);
  expect(res.unresolved).toHaveLength(1);
  expect(res.unresolved[0].deviceName).toBe("ZZTOP99-LT-001");

  const item = await prisma.item.findFirst({ where: { serialNumber: "UNRESOLVED-1" } });
  expect(item).not.toBeNull();
  expect(item?.homeUnit).toBeNull();
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

test("commitImport overwrites an existing item's storageLocation from the CSV and logs the change", async () => {
  await createItem({ make: "Dell", model: "5540", serialNumber: "SL1", deviceName: "Radio", homeUnit: undefined, notes: undefined, storageLocation: "Bldg 400" }, admin.id);

  const csv = "serialNumber,deviceName,SLoc\nSL1,Radio,Bldg 401\n";
  const res = await commitImport(csv, "items.csv", [], admin);
  expect(res.updated).toBe(1);

  const item = await prisma.item.findUniqueOrThrow({ where: { serialNumber: "SL1" } });
  expect(item.storageLocation).toBe("Bldg 401");

  const edits = await prisma.itemEdit.findMany({ where: { itemId: item.id } });
  expect(edits).toHaveLength(1);
  expect(edits[0].changes).toEqual([{ field: "storageLocation", from: "Bldg 400", to: "Bldg 401" }]);
});
