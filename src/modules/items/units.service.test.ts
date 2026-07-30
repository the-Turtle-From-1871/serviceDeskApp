import { beforeAll, beforeEach, expect, test } from "vitest";
import prisma from "@/lib/prisma";
import { resetDb, migrateTestDb } from "../../../tests/helpers/db";
import {
  loadUnitMap,
  learnUnits,
  listUnits,
  listUnitsWithCounts,
  countItemsWithHomeUnit,
  renameUnit,
  deleteUnit,
  listUnassignedHomeUnits,
  lastImportAt,
} from "./units.service";

// resetDb() TRUNCATEs User (and Item, Unit) before every test, so no admin
// exists yet — each test that needs an editor/creator must make its own.
function createAdmin() {
  return prisma.user.create({
    data: { name: "Admin", email: `admin-${Math.random().toString(36).slice(2)}@test.mil`, passwordHash: "x", role: "ADMIN" },
  });
}

beforeAll(() => migrateTestDb());
beforeEach(() => resetDb());

test("loadUnitMap keys by uppercase abbreviation", async () => {
  await prisma.unit.create({ data: { abbreviation: "DCSIM", fullName: "DCSIM" } });
  const map = await loadUnitMap();
  expect(map.get("DCSIM")).toBe("DCSIM");
});

test("learnUnits upserts new units, uppercasing the abbreviation", async () => {
  await learnUnits([{ abbreviation: "xyz", fullName: "456th Signal Co" }]);
  const row = await prisma.unit.findUnique({ where: { abbreviation: "XYZ" } });
  expect(row?.fullName).toBe("456th Signal Co");
});

test("learnUnits updates the full name of an existing abbreviation", async () => {
  await prisma.unit.create({ data: { abbreviation: "XYZ", fullName: "Old" } });
  await learnUnits([{ abbreviation: "XYZ", fullName: "New" }]);
  const row = await prisma.unit.findUnique({ where: { abbreviation: "XYZ" } });
  expect(row?.fullName).toBe("New");
});

test("learnUnits rejects a non-alphanumeric abbreviation and writes nothing", async () => {
  await expect(learnUnits([{ abbreviation: "X-Y", fullName: "Bad" }])).rejects.toThrow();
  expect(await prisma.unit.count()).toBe(0);
});

test("learnUnits accepts an empty array (no-op)", async () => {
  await learnUnits([]);
  expect(await prisma.unit.count()).toBe(0);
});

// --- Unit.abbreviation is citext ------------------------------------------
// An abbreviation is an identity, so "WABC01" and "wabc01" must be ONE unit.
// Without citext the uppercasing in learnUnits is convention-only, and any
// write site that forgets it forks the unit into a second row that resolves
// differently.

test("two casings of one abbreviation cannot both exist", async () => {
  await prisma.unit.create({ data: { abbreviation: "CITEST01", fullName: "First" } });
  await expect(
    prisma.unit.create({ data: { abbreviation: "citest01", fullName: "Second" } })
  ).rejects.toThrow();
});

test("a unit is found regardless of the casing looked up", async () => {
  await prisma.unit.create({ data: { abbreviation: "CITEST01", fullName: "First" } });
  const found = await prisma.unit.findUnique({ where: { abbreviation: "citest01" } });
  expect(found?.fullName).toBe("First");
});

test("listUnits returns abbreviation + fullName ordered by fullName", async () => {
  await prisma.unit.create({ data: { abbreviation: "ZED", fullName: "Zulu Company" } });
  await prisma.unit.create({ data: { abbreviation: "ALP", fullName: "Alpha Company" } });
  const units = await listUnits();
  expect(units).toEqual([
    { abbreviation: "ALP", fullName: "Alpha Company" },
    { abbreviation: "ZED", fullName: "Zulu Company" },
  ]);
});

// --- batching -----------------------------------------------------------
// learnUnits used to be a `for` loop of upserts (one round trip per row).
// These lock in the semantics so a batched rewrite can't change behaviour.

test("learnUnits creates new units and updates existing names in one call", async () => {
  await prisma.unit.create({ data: { abbreviation: "BATCH01", fullName: "Old Name" } });

  const res = await learnUnits([
    { abbreviation: "batch01", fullName: "New Name" },
    { abbreviation: "batch02", fullName: "Second Unit" },
  ]);

  expect(res).toEqual({ created: 1, updated: 1 });
  const map = await loadUnitMap();
  expect(map.get("BATCH01")).toBe("New Name");
  expect(map.get("BATCH02")).toBe("Second Unit");
});

test("learnUnits stores abbreviations uppercased regardless of input casing", async () => {
  await learnUnits([{ abbreviation: "batch02", fullName: "Second Unit" }]);
  const row = await prisma.unit.findUnique({ where: { abbreviation: "BATCH02" } });
  expect(row?.abbreviation).toBe("BATCH02");
});

test("learnUnits is a no-op on an empty list", async () => {
  await expect(learnUnits([])).resolves.toEqual({ created: 0, updated: 0 });
});

// --- listUnitsWithCounts -------------------------------------------------

test("listUnitsWithCounts reports item counts per unit, and 0 for an unused unit", async () => {
  const admin = await createAdmin();
  const used = await prisma.unit.create({ data: { abbreviation: "CNT01", fullName: "Counted Unit" } });
  const unused = await prisma.unit.create({ data: { abbreviation: "CNT02", fullName: "Empty Unit" } });
  await prisma.item.createMany({
    data: [
      { make: "D", model: "1", serialNumber: "CNT-1", homeUnit: "Counted Unit", createdById: admin.id },
      { make: "D", model: "1", serialNumber: "CNT-2", homeUnit: "Counted Unit", createdById: admin.id },
    ],
  });

  const rows = await listUnitsWithCounts();
  const byId = new Map(rows.map((r) => [r.id, r]));
  expect(byId.get(used.id)?.itemCount).toBe(2);
  expect(byId.get(unused.id)?.itemCount).toBe(0);
});

// --- countItemsWithHomeUnit -----------------------------------------------

test("countItemsWithHomeUnit counts items carrying the exact full name", async () => {
  const admin = await createAdmin();
  await prisma.item.createMany({
    data: [
      { make: "D", model: "1", serialNumber: "HU-1", homeUnit: "Some Unit", createdById: admin.id },
      { make: "D", model: "1", serialNumber: "HU-2", homeUnit: "Other Unit", createdById: admin.id },
    ],
  });
  expect(await countItemsWithHomeUnit("Some Unit")).toBe(1);
  expect(await countItemsWithHomeUnit("Nonexistent Unit")).toBe(0);
});

// --- renameUnit -------------------------------------------------------

test("renameUnit rewrites every item carrying the old full name and logs each change", async () => {
  const unit = await prisma.unit.create({
    data: { abbreviation: "RENAME01", fullName: "Old Full Name" },
  });
  const admin = await createAdmin();
  await prisma.item.createMany({
    data: [
      { make: "D", model: "1", serialNumber: "RN-1", homeUnit: "Old Full Name", createdById: admin.id },
      { make: "D", model: "1", serialNumber: "RN-2", homeUnit: "Old Full Name", createdById: admin.id },
      { make: "D", model: "1", serialNumber: "RN-3", homeUnit: "Untouched", createdById: admin.id },
    ],
  });

  const res = await renameUnit(unit.id, "New Full Name", { id: admin.id, name: admin.name });

  expect(res.itemsUpdated).toBe(2);
  expect((await prisma.item.findFirstOrThrow({ where: { serialNumber: "RN-1" } })).homeUnit).toBe("New Full Name");
  expect((await prisma.item.findFirstOrThrow({ where: { serialNumber: "RN-3" } })).homeUnit).toBe("Untouched");

  const item1 = await prisma.item.findFirstOrThrow({ where: { serialNumber: "RN-1" } });
  const edits = await prisma.itemEdit.findMany({ where: { itemId: item1.id } });
  expect(edits).toHaveLength(1);
  expect(edits[0].changes).toEqual([{ field: "homeUnit", from: "Old Full Name", to: "New Full Name" }]);

  // The untouched item must get NO history row at all — a rename that logged
  // edits for items it didn't change would pollute every item's history.
  const item3 = await prisma.item.findFirstOrThrow({ where: { serialNumber: "RN-3" } });
  expect(await prisma.itemEdit.count({ where: { itemId: item3.id } })).toBe(0);
});

test("renameUnit gives NO history row and NO credit to an item already spelled like the new name", async () => {
  // A rename is often really "fix the casing" — e.g. "1st BN" -> "1st Bn" —
  // and some items may already carry the target spelling. Those rows still
  // match the OLD name case-insensitively (so they get swept into `affected`
  // and touched by the bulk UPDATE), but diffItemFields sees no real change
  // once normalized, so they must be excluded from both the ItemEdit rows
  // and itemsUpdated, or the count over-reports and /admin/audit shows a
  // blank "Changed" cell for a row that didn't change.
  const unit = await prisma.unit.create({ data: { abbreviation: "RENAME04", fullName: "1st BN" } });
  const admin = await createAdmin();
  await prisma.item.createMany({
    data: [
      // Matches the OLD name case-insensitively, but its stored value is
      // ALREADY the exact new spelling.
      { make: "D", model: "1", serialNumber: "RN-ALREADY", homeUnit: "1st Bn", createdById: admin.id },
      // Genuinely needs rewriting.
      { make: "D", model: "1", serialNumber: "RN-NEEDS-IT", homeUnit: "1st BN", createdById: admin.id },
    ],
  });

  const res = await renameUnit(unit.id, "1st Bn", { id: admin.id, name: admin.name });

  expect(res.itemsUpdated).toBe(1);

  const already = await prisma.item.findFirstOrThrow({ where: { serialNumber: "RN-ALREADY" } });
  expect(already.homeUnit).toBe("1st Bn");
  expect(await prisma.itemEdit.count({ where: { itemId: already.id } })).toBe(0);

  const needed = await prisma.item.findFirstOrThrow({ where: { serialNumber: "RN-NEEDS-IT" } });
  expect(needed.homeUnit).toBe("1st Bn");
  const edits = await prisma.itemEdit.findMany({ where: { itemId: needed.id } });
  expect(edits).toHaveLength(1);
  expect(edits[0].changes).toEqual([{ field: "homeUnit", from: "1st BN", to: "1st Bn" }]);
});

test("renameUnit writes nothing when the name is unchanged", async () => {
  const unit = await prisma.unit.create({ data: { abbreviation: "RENAME02", fullName: "Same" } });
  const admin = await createAdmin();
  // An item carrying the (unchanged) name proves this is a real no-op, not a
  // vacuous one: an implementation that ran the whole transaction and wrote
  // empty-`changes` ItemEdit rows would still report itemsUpdated: 0 here if
  // no item existed to touch.
  const item = await prisma.item.create({
    data: { make: "D", model: "1", serialNumber: "NOOP-1", homeUnit: "Same", createdById: admin.id },
  });

  const res = await renameUnit(unit.id, "Same", { id: admin.id, name: admin.name });

  expect(res.itemsUpdated).toBe(0);
  expect(await prisma.itemEdit.count()).toBe(0);
  expect((await prisma.item.findUniqueOrThrow({ where: { id: item.id } })).homeUnit).toBe("Same");
});

// --- case/whitespace-insensitive matching --------------------------------
// Item.homeUnit reaches the column via CSV passthrough and hand edits, not
// only as a verbatim copy of Unit.fullName, so arbitrary case and stray
// whitespace genuinely land in the fleet. listUnitsWithCounts, renameUnit
// and deleteUnit must all still recognize those rows as belonging to the
// unit, or a differently-cased item survives a rename as a second spelling,
// or blocks a delete it should not block (or vice versa).

test("case- and whitespace-differing homeUnit values are still matched to the unit", async () => {
  const admin = await createAdmin();
  const unit = await prisma.unit.create({ data: { abbreviation: "CI01", fullName: "Alpha Company" } });
  await prisma.item.createMany({
    data: [
      // Differs only by case.
      { make: "D", model: "1", serialNumber: "CI-1", homeUnit: "ALPHA COMPANY", createdById: admin.id },
      // Differs only by leading/trailing whitespace.
      { make: "D", model: "1", serialNumber: "CI-2", homeUnit: "  Alpha Company  ", createdById: admin.id },
    ],
  });

  // Counted by listUnitsWithCounts despite the differing casing/whitespace.
  const rows = await listUnitsWithCounts();
  expect(rows.find((r) => r.id === unit.id)?.itemCount).toBe(2);

  // deleteUnit must refuse: both rows still, in effect, point at this unit.
  await expect(deleteUnit(unit.id)).rejects.toThrow(/still/i);

  // renameUnit must find and rewrite both rows.
  const res = await renameUnit(unit.id, "Alpha Co", { id: admin.id, name: admin.name });
  expect(res.itemsUpdated).toBe(2);
  expect((await prisma.item.findFirstOrThrow({ where: { serialNumber: "CI-1" } })).homeUnit).toBe("Alpha Co");
  expect((await prisma.item.findFirstOrThrow({ where: { serialNumber: "CI-2" } })).homeUnit).toBe("Alpha Co");
});

test("renameUnit throws NOT_FOUND for a missing unit", async () => {
  const admin = await createAdmin();
  await expect(
    renameUnit("does-not-exist", "New Name", { id: admin.id, name: admin.name }),
  ).rejects.toThrow(/no longer exists/i);
});

test("renameUnit rejects a blank name", async () => {
  const unit = await prisma.unit.create({ data: { abbreviation: "RENAME03", fullName: "Something" } });
  const admin = await createAdmin();
  await expect(renameUnit(unit.id, "   ", { id: admin.id, name: admin.name })).rejects.toThrow(/enter a unit name/i);
});

// --- deleteUnit ---------------------------------------------------------

test("deleteUnit refuses while items still carry the full name", async () => {
  const unit = await prisma.unit.create({ data: { abbreviation: "DEL01", fullName: "In Use Unit" } });
  const admin = await createAdmin();
  await prisma.item.create({
    data: { make: "D", model: "1", serialNumber: "DEL-1", homeUnit: "In Use Unit", createdById: admin.id },
  });
  await expect(deleteUnit(unit.id)).rejects.toThrow(/still/i);
  expect(await prisma.unit.findUnique({ where: { id: unit.id } })).not.toBeNull();
});

test("deleteUnit deletes an unused unit", async () => {
  const unit = await prisma.unit.create({ data: { abbreviation: "DEL02", fullName: "Unused Unit" } });
  await deleteUnit(unit.id);
  expect(await prisma.unit.findUnique({ where: { id: unit.id } })).toBeNull();
});

test("deleteUnit throws NOT_FOUND for a missing unit", async () => {
  await expect(deleteUnit("does-not-exist")).rejects.toThrow(/no longer exists/i);
});

// --- listUnassignedHomeUnits ---------------------------------------------

test("listUnassignedHomeUnits returns active items with a device name but no home unit", async () => {
  const admin = await createAdmin();
  await prisma.item.create({
    data: { make: "D", model: "1", serialNumber: "NOUNIT-1", deviceName: "ZZTOP99-LT-1", createdById: admin.id },
  });
  const rows = await listUnassignedHomeUnits();
  expect(rows.some((r) => r.deviceName === "ZZTOP99-LT-1")).toBe(true);
});

test("listUnassignedHomeUnits excludes items that already have a home unit", async () => {
  const admin = await createAdmin();
  await prisma.item.create({
    data: {
      make: "D",
      model: "1",
      serialNumber: "HASUNIT-1",
      deviceName: "HASUNIT-LT-1",
      homeUnit: "Some Unit",
      createdById: admin.id,
    },
  });
  const rows = await listUnassignedHomeUnits();
  expect(rows.some((r) => r.deviceName === "HASUNIT-LT-1")).toBe(false);
});

// --- lastImportAt ---------------------------------------------------------

test("lastImportAt returns null when nothing has ever been imported", async () => {
  expect(await lastImportAt()).toBeNull();
});

test("lastImportAt returns the createdAt of the most recent import batch", async () => {
  const admin = await createAdmin();
  await prisma.importBatch.create({
    data: {
      createdById: admin.id,
      filename: "old.csv",
      addedCount: 1,
      skippedCount: 0,
      skipped: [],
      createdAt: new Date("2026-01-01T00:00:00Z"),
    },
  });
  const newest = await prisma.importBatch.create({
    data: {
      createdById: admin.id,
      filename: "new.csv",
      addedCount: 1,
      skippedCount: 0,
      skipped: [],
      createdAt: new Date("2026-01-02T00:00:00Z"),
    },
  });
  expect((await lastImportAt())?.toISOString()).toBe(newest.createdAt.toISOString());
});
