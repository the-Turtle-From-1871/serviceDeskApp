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

  const res = await commitImport(csv, "items.csv", admin);

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

  const res = await commitImport(csv, "items.csv", admin);
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
  const res = await commitImport(csv, "items.csv", admin);
  expect(res.updated).toBe(1);
  const item = await prisma.item.findUniqueOrThrow({ where: { serialNumber: "UP2" } });
  expect(item.compliance).toBe("Noncompliant");
  expect(await prisma.itemEdit.count({ where: { itemId: item.id } })).toBe(0);
});

test("commitImport updates a RETIRED item's fields but writes no ItemEdit", async () => {
  await createItem({ make: "Dell", model: "5540", serialNumber: "RET1", deviceName: "Old", homeUnit: undefined, notes: undefined }, admin.id);
  await prisma.item.update({ where: { serialNumber: "RET1" }, data: { status: "RETIRED" } });

  const csv = "serialNumber,deviceName,assignedUser,compliance\nRET1,NewName,jane@x.mil,Compliant\n";
  const res = await commitImport(csv, "items.csv", admin);
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
  const res = await commitImport("make,model\nM4,Carbine\n", "bad.csv", admin);
  expect(res.added).toBe(0);
  expect(res.error).toMatch(/serialNumber/);
  expect(await prisma.item.count()).toBe(0);
  expect(await prisma.importBatch.count()).toBe(0);
});

test("commitImport overwrites an existing item's homeUnit from the CSV and logs the change", async () => {
  await createItem({ make: "Dell", model: "5540", serialNumber: "HU1", deviceName: "Radio", homeUnit: "Old Unit", notes: undefined }, admin.id);

  const csv = "serialNumber,deviceName,homeUnit\nHU1,Radio,New Unit\n";
  const res = await commitImport(csv, "items.csv", admin);
  expect(res.updated).toBe(1);

  const item = await prisma.item.findUniqueOrThrow({ where: { serialNumber: "HU1" } });
  expect(item.homeUnit).toBe("New Unit");

  const edits = await prisma.itemEdit.findMany({ where: { itemId: item.id } });
  expect(edits).toHaveLength(1);
  expect(edits[0].changes).toEqual([{ field: "homeUnit", from: "Old Unit", to: "New Unit" }]);
});

// Home units are no longer derived from device names (2026-08-11), so a blank
// homeUnit column imports as blank whatever the device name looks like — there
// is nothing to derive, nothing to report as unresolved and nothing to teach.
test("commitImport leaves homeUnit blank when the CSV column is blank", async () => {
  const csv = [
    "serialNumber,make,model,deviceName",
    // A name that WOULD have decoded before the removal, with a unit seeded
    // below, so this fails loudly if derivation ever comes back.
    "NOUNIT-1,Dell,7440,HI-XYZ-LT-001",
  ].join("\n");
  await prisma.unit.create({ data: { abbreviation: "XYZ", fullName: "456th Signal Co" } });

  const res = await commitImport(csv, "fleet.csv", admin);

  expect(res.added).toBe(1);
  const item = await prisma.item.findFirst({ where: { serialNumber: "NOUNIT-1" } });
  expect(item).not.toBeNull();
  expect(item?.homeUnit).toBeNull();
});

test("commitImport takes homeUnit from the CSV column when it is supplied", async () => {
  const csv = [
    "make,model,serialNumber,deviceName,homeUnit,notes",
    "M4,Carbine,A1,HI-XYZ-LT-001,456th Signal Co,",
    "M4,Carbine,A2,HI-XYZ-DT-002,456th Signal Co,",
  ].join("\n");
  const res = await commitImport(csv, "items.csv", admin);
  expect(res.added).toBe(2);
  const homeUnits = (await prisma.item.findMany({ select: { homeUnit: true } })).map((i) => i.homeUnit);
  expect(homeUnits).toEqual(["456th Signal Co", "456th Signal Co"]);
});

test("commitImport overwrites an existing item's storageLocation from the CSV and logs the change", async () => {
  await createItem({ make: "Dell", model: "5540", serialNumber: "SL1", deviceName: "Radio", homeUnit: undefined, notes: undefined, storageLocation: "Bldg 400" }, admin.id);

  const csv = "serialNumber,deviceName,SLoc\nSL1,Radio,Bldg 401\n";
  const res = await commitImport(csv, "items.csv", admin);
  expect(res.updated).toBe(1);

  const item = await prisma.item.findUniqueOrThrow({ where: { serialNumber: "SL1" } });
  expect(item.storageLocation).toBe("Bldg 401");

  const edits = await prisma.itemEdit.findMany({ where: { itemId: item.id } });
  expect(edits).toHaveLength(1);
  expect(edits[0].changes).toEqual([{ field: "storageLocation", from: "Bldg 400", to: "Bldg 401" }]);
});

test("commitImport stamps lastImportedAt on EVERY row the file carried", async () => {
  // The whole missing-from-census mechanism rests on this stamp, and the
  // unchanged rows are the half that is easy to miss: on a steady fleet most
  // rows change nothing, so stamping only the updates would report ~1,000
  // devices as absent from an import that listed every one of them.
  await createItem(
    { make: "Dell", model: "5540", serialNumber: "SAME1", deviceName: "Radio", homeUnit: undefined, notes: undefined },
    admin.id,
  );
  await createItem(
    { make: "Dell", model: "5540", serialNumber: "CHANGED1", deviceName: "OldName", homeUnit: undefined, notes: undefined },
    admin.id,
  );

  const before = new Date();
  const csv = [
    "make,model,serialNumber,deviceName",
    "Dell,5540,SAME1,Radio",       // matches exactly -> unchanged, writes nothing
    "Dell,5540,CHANGED1,NewName",  // -> updated
    "HP,X360,BRANDNEW1,Fresh",     // -> created
  ].join("\n");

  const res = await commitImport(csv, "items.csv", admin);
  expect(res.error).toBeUndefined();
  expect(res.unchanged).toBe(1);
  expect(res.updated).toBe(1);
  expect(res.added).toBe(1);

  const rows = await prisma.item.findMany({
    where: { serialNumber: { in: ["SAME1", "CHANGED1", "BRANDNEW1"] } },
    select: { serialNumber: true, lastImportedAt: true },
    orderBy: { serialNumber: "asc" },
  });
  for (const r of rows) {
    expect(r.lastImportedAt, `${r.serialNumber} was not stamped`).not.toBeNull();
    expect(r.lastImportedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
  }
  // ONE instant for the whole import, so "seen in the same import" is an exact
  // equality rather than a range.
  const stamps = new Set(rows.map((r) => r.lastImportedAt!.getTime()));
  expect(stamps.size).toBe(1);
});

test("an unchanged row's stamp moves without its updatedAt moving", async () => {
  // The stamp is written in raw SQL precisely so Prisma's @updatedAt does not
  // fire: bumping updatedAt on a thousand untouched rows every night would
  // destroy the one signal meaning "something about this device changed".
  await createItem(
    { make: "Dell", model: "5540", serialNumber: "STEADY1", deviceName: "Radio", homeUnit: undefined, notes: undefined },
    admin.id,
  );
  const csv = "make,model,serialNumber,deviceName\nDell,5540,STEADY1,Radio\n";

  await commitImport(csv, "first.csv", admin);
  const after1 = await prisma.item.findUniqueOrThrow({ where: { serialNumber: "STEADY1" } });

  await commitImport(csv, "second.csv", admin);
  const after2 = await prisma.item.findUniqueOrThrow({ where: { serialNumber: "STEADY1" } });

  expect(after2.lastImportedAt!.getTime()).toBeGreaterThan(after1.lastImportedAt!.getTime());
  expect(after2.updatedAt.getTime()).toBe(after1.updatedAt.getTime());
});

test("a real census import does NOT report the devices it just carried as missing", async () => {
  // The end-to-end version of the boundary, and the one that catches a bug the
  // hand-built fixtures cannot: `importedAt` is taken before the transaction
  // opens, so if ImportBatch.createdAt were left to default to now() every
  // device the census had just listed would be stamped a few milliseconds
  // EARLIER than the census recording it — and the entire fleet would read as
  // missing from the import that carried it.
  const { listDroppedDevices } = await import("@/app/admin/analytics/analytics.service");

  const csv = [
    "make,model,serialNumber,deviceName",
    "Dell,5540,CENSUS1,LAPTOP-1",
    "Dell,5540,CENSUS2,LAPTOP-2",
  ].join("\n");

  // sourceHash non-null = the scheduled Drive pull, i.e. a fleet census.
  const res = await commitImport(csv, "drive-import.csv", admin, "hash-abc");
  expect(res.error).toBeUndefined();
  expect(res.added).toBe(2);

  const batch = await prisma.importBatch.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
  const items = await prisma.item.findMany({ select: { lastImportedAt: true } });
  for (const i of items) {
    expect(i.lastImportedAt!.getTime()).toBe(batch.createdAt.getTime());
  }

  // Neither device is missing from the census that just listed it. They still
  // have no sync time, so they appear for THAT reason — as "Never enrolled",
  // never as "Missing from import".
  const { rows } = await listDroppedDevices({ uic: null, unit: null });
  expect(rows.map((r) => r["MDM record"])).toEqual(["Never enrolled", "Never enrolled"]);
  expect(rows.every((r) => r["Dropped off"] === "")).toBe(true);
});
