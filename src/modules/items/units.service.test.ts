import { beforeAll, beforeEach, expect, test } from "vitest";
import prisma from "@/lib/prisma";
import { resetDb, migrateTestDb } from "../../../tests/helpers/db";
import { loadUnitMap, learnUnits } from "./units.service";

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
