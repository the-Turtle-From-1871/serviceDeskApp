import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import prisma from "@/lib/prisma";
import { resetDb, migrateTestDb } from "../../../../tests/helpers/db";
import { getUnitAllocations, itemWhere } from "./analytics.service";

/* ============================================================
   Unit-allocation grouping.

   DB-backed rather than mocked: the whole point of the dimension switch is
   which column Postgres GROUPs BY and how it folds blanks into one bucket —
   asserting on a mocked query argument would only re-state the SQL, not test
   that it partitions the fleet correctly.
   ============================================================ */

let adminId: string;

beforeAll(() => migrateTestDb());
beforeEach(async () => {
  await resetDb();
  const admin = await prisma.user.create({
    data: { name: "Admin", email: "a@x.co", passwordHash: "x", role: "ADMIN" },
  });
  adminId = admin.id;
});

let serialSeq = 0;
/** One item. Serials are generated because `Item.serialNumber` is citext-unique
 *  and these tests never assert on them. */
function mkItem(data: {
  homeUnit?: string | null;
  deviceUIC?: string | null;
  status?: "ACTIVE" | "RETIRED";
  markedReadyAt?: Date;
  lastLogonUserPrincipalName?: string;
}) {
  return prisma.item.create({
    data: {
      make: "Dell",
      model: "5540",
      serialNumber: `SN-${++serialSeq}`,
      createdById: adminId,
      ...data,
    },
  });
}

/** The rows keyed by their grouping value, so assertions read by name rather
 *  than by index. */
const byValue = (rows: Awaited<ReturnType<typeof getUnitAllocations>>["rows"]) =>
  new Map(rows.map((r) => [r.value, r]));

describe("getUnitAllocations — grouping dimension", () => {
  test("groups by homeUnit when the dimension is 'unit'", async () => {
    await mkItem({ homeUnit: "Alpha Co", deviceUIC: "WAAAAA" });
    await mkItem({ homeUnit: "Alpha Co", deviceUIC: "WBBBBB" });
    await mkItem({ homeUnit: "Bravo Co", deviceUIC: "WAAAAA" });

    const { rows } = await getUnitAllocations("unit");

    // One row per NAME, and a name that spans two UICs is not split by them.
    expect(rows.map((r) => r.value)).toEqual(["Alpha Co", "Bravo Co"]);
    expect(byValue(rows).get("Alpha Co")?.total).toBe(2);
  });

  test("groups by deviceUIC when the dimension is 'uic'", async () => {
    await mkItem({ homeUnit: "Alpha Co", deviceUIC: "WAAAAA" });
    await mkItem({ homeUnit: "Alpha Co", deviceUIC: "WBBBBB" });
    await mkItem({ homeUnit: "Bravo Co", deviceUIC: "WAAAAA" });

    const { rows } = await getUnitAllocations("uic");

    // The SAME fleet partitions differently — which is why the dropdown must
    // re-query rather than relabel the rows of the other dimension.
    expect(rows.map((r) => r.value)).toEqual(["WAAAAA", "WBBBBB"]);
    expect(byValue(rows).get("WAAAAA")?.total).toBe(2);
  });

  test("orders by total desc, then by value", async () => {
    await mkItem({ homeUnit: "Zulu Co" });
    await mkItem({ homeUnit: "Alpha Co" });
    await mkItem({ homeUnit: "Alpha Co" });
    await mkItem({ homeUnit: "Mike Co" });

    const { rows } = await getUnitAllocations("unit");
    expect(rows.map((r) => r.value)).toEqual(["Alpha Co", "Mike Co", "Zulu Co"]);
  });
});

describe("getUnitAllocations — the Unassigned bucket", () => {
  test("surfaces items with no unit name as one Unassigned row", async () => {
    await mkItem({ homeUnit: "Alpha Co" });
    await mkItem({ homeUnit: null });
    await mkItem({ homeUnit: "" });
    await mkItem({ homeUnit: "   " });

    const { rows } = await getUnitAllocations("unit");

    // null, "" and whitespace are ONE bucket, not three look-alike rows.
    const unassigned = byValue(rows).get(null);
    expect(unassigned?.total).toBe(3);
    expect(rows.filter((r) => r.value === null)).toHaveLength(1);
  });

  test("surfaces items with no UIC as one Unassigned row", async () => {
    await mkItem({ deviceUIC: "WAAAAA" });
    await mkItem({ deviceUIC: null });
    await mkItem({ deviceUIC: "  " });

    const { rows } = await getUnitAllocations("uic");
    expect(byValue(rows).get(null)?.total).toBe(2);
  });

  test("totals reconcile with the fleet count in either dimension", async () => {
    await mkItem({ homeUnit: "Alpha Co", deviceUIC: "WAAAAA" });
    await mkItem({ homeUnit: null, deviceUIC: "WAAAAA" });
    await mkItem({ homeUnit: "Bravo Co", deviceUIC: null });
    await mkItem({ homeUnit: null, deviceUIC: null });

    // The page header counts the fleet; if the Unassigned bucket were dropped
    // the table would silently disagree with it.
    const fleet = await prisma.item.count({ where: itemWhere({ uic: null, unit: null }) });
    const sum = async (dim: "unit" | "uic") =>
      (await getUnitAllocations(dim)).rows.reduce((n, r) => n + r.total, 0);

    expect(await sum("unit")).toBe(fleet);
    expect(await sum("uic")).toBe(fleet);
  });

  test("returns no rows at all only when the catalogue is empty of active items", async () => {
    await mkItem({ homeUnit: null, status: "RETIRED" });
    const { rows } = await getUnitAllocations("unit");
    expect(rows).toEqual([]);
  });
});

describe("getUnitAllocations — readiness columns", () => {
  test("counts Deployed and Ready per row and excludes retired kit", async () => {
    // markedReadyAt with no later logon => READY_TO_DEPLOY.
    await mkItem({ homeUnit: "Alpha Co", markedReadyAt: new Date("2026-01-01") });
    // A named MDM logon and nothing contradicting it => DEPLOYED.
    await mkItem({ homeUnit: "Alpha Co", lastLogonUserPrincipalName: "pfc@army.mil" });
    // Neither => UNTRIAGED: in Total, in neither of the two columns.
    await mkItem({ homeUnit: "Alpha Co" });
    // Lifecycle-retired: out of Total, so it must be out of the columns too or
    // Deployed + Ready could exceed Total.
    await mkItem({
      homeUnit: "Alpha Co",
      status: "RETIRED",
      lastLogonUserPrincipalName: "pfc@army.mil",
    });

    const row = byValue((await getUnitAllocations("unit")).rows).get("Alpha Co");
    expect(row).toMatchObject({ total: 3, deployed: 1, ready: 1 });
  });

  test("counts readiness for the Unassigned bucket too", async () => {
    await mkItem({ homeUnit: null, markedReadyAt: new Date("2026-01-01") });
    await mkItem({ homeUnit: null, lastLogonUserPrincipalName: "pfc@army.mil" });

    const row = byValue((await getUnitAllocations("unit")).rows).get(null);
    expect(row).toMatchObject({ total: 2, deployed: 1, ready: 1 });
  });
});

describe("getUnitAllocations — bounding", () => {
  test("caps the row count and reports the truncation", async () => {
    await mkItem({ deviceUIC: "WAAAAA" });
    await mkItem({ deviceUIC: "WBBBBB" });
    await mkItem({ deviceUIC: "WCCCCC" });

    const { rows, truncated } = await getUnitAllocations("uic", 2);
    expect(rows).toHaveLength(2);
    expect(truncated).toBe(true);
  });

  test("reports no truncation when every group fits", async () => {
    await mkItem({ deviceUIC: "WAAAAA" });
    await mkItem({ deviceUIC: "WBBBBB" });

    const { rows, truncated } = await getUnitAllocations("uic", 2);
    expect(rows).toHaveLength(2);
    expect(truncated).toBe(false);
  });
});

describe("itemWhere — the global scope", () => {
  test("filters on nothing but the ACTIVE lifecycle when unscoped", () => {
    expect(itemWhere({ uic: null, unit: null })).toEqual({ status: "ACTIVE" });
  });

  test("scopes by UIC alone", () => {
    expect(itemWhere({ uic: "WAAAAA", unit: null })).toEqual({
      status: "ACTIVE",
      deviceUIC: "WAAAAA",
    });
  });

  test("scopes by unit name alone", () => {
    expect(itemWhere({ uic: null, unit: "Alpha Co" })).toEqual({
      status: "ACTIVE",
      homeUnit: "Alpha Co",
    });
  });

  test("composes both dimensions with AND", () => {
    expect(itemWhere({ uic: "WAAAAA", unit: "Alpha Co" })).toEqual({
      status: "ACTIVE",
      deviceUIC: "WAAAAA",
      homeUnit: "Alpha Co",
    });
  });

  test("the composed scope narrows the fleet count to the intersection", async () => {
    await mkItem({ homeUnit: "Alpha Co", deviceUIC: "WAAAAA" });
    await mkItem({ homeUnit: "Alpha Co", deviceUIC: "WBBBBB" });
    await mkItem({ homeUnit: "Bravo Co", deviceUIC: "WAAAAA" });
    await mkItem({ homeUnit: "Alpha Co", deviceUIC: "WAAAAA", status: "RETIRED" });

    const count = (scope: { uic: string | null; unit: string | null }) =>
      prisma.item.count({ where: itemWhere(scope) });

    expect(await count({ uic: "WAAAAA", unit: null })).toBe(2);
    expect(await count({ uic: null, unit: "Alpha Co" })).toBe(2);
    expect(await count({ uic: "WAAAAA", unit: "Alpha Co" })).toBe(1);
  });
});
