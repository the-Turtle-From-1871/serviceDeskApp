import { beforeAll, beforeEach, expect, test } from "vitest";
import prisma from "@/lib/prisma";
import { resetDb, migrateTestDb } from "../../../tests/helpers/db";
import { loadUnitMap, learnUnits, listUnits } from "./units.service";

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
