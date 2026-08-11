import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import prisma from "@/lib/prisma";
import { resetDb, migrateTestDb } from "../../../../tests/helpers/db";
import {
  countStaleDevices,
  getUnitAllocations,
  itemWhere,
  listStaleDevices,
  staleSyncWindow,
} from "./analytics.service";
import { STALE_MIN_DAYS, STALE_MAX_DAYS } from "./analytics.types";

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
  lastLogonAt?: Date | null;
  lastSyncAt?: Date | null;
  compliance?: string | null;
  deviceName?: string;
  serialNumber?: string;
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

/* ============================================================
   Stale devices — the 30-90 day export.

   DB-backed for the same reason as the allocations above: what is being tested
   is which rows Postgres returns for a window and a NOT EXISTS over live
   custody. Asserting on a built query string would only restate the SQL.

   `now` is injected everywhere, so these assert on real boundaries rather than
   on whatever the wall clock happens to be when CI runs.
   ============================================================ */

const NOW = new Date("2026-08-10T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY_MS);
const UNSCOPED = { uic: null, unit: null };

let receiptSeq = 0;
/** Put an item into LIVE custody: an OPEN receipt carrying an unreturned line.
 *  Both halves matter — the export subtracts exactly this shape, and either one
 *  alone describes a receipt whose custody has already ended. */
async function issueOnOpenReceipt(
  itemId: string,
  serialNumber: string,
  opts: { status?: "OPEN" | "CLOSED"; returnedAt?: Date | null } = {},
) {
  await prisma.transfer.create({
    data: {
      receiptNumber: `HR-${String(++receiptSeq).padStart(6, "0")}`,
      itemSummary: "1 x Dell 5540",
      senderName: "Sender",
      receiverName: "Receiver",
      receiverSignature: "data:image/png;base64,AA==",
      status: opts.status ?? "OPEN",
      ...(opts.status === "CLOSED" ? { closedAt: daysAgo(1) } : {}),
      lines: {
        create: {
          lineNo: 1,
          make: "Dell",
          model: "5540",
          qtyAuth: 1,
          qtyIssued: 1,
          items: { create: { itemId, serialNumber, returnedAt: opts.returnedAt ?? null } },
        },
      },
    },
  });
}

const serialsOf = (rows: Awaited<ReturnType<typeof listStaleDevices>>["rows"]) =>
  rows.map((r) => r.Serial);

describe("staleSyncWindow", () => {
  test("spans from 90 days ago to 30 days ago", () => {
    const { from, to } = staleSyncWindow(NOW);
    expect(from).toEqual(daysAgo(STALE_MAX_DAYS));
    expect(to).toEqual(daysAgo(STALE_MIN_DAYS));
  });
});

describe("listStaleDevices — what lands in the sheet", () => {
  test("includes only devices last seen inside the window", async () => {
    await mkItem({ serialNumber: "FRESH", lastSyncAt: daysAgo(15) });
    await mkItem({ serialNumber: "STALE", lastSyncAt: daysAgo(45) });
    // Past 90 days: a different problem, deliberately excluded (the whole point
    // of the upper bound).
    await mkItem({ serialNumber: "LOST", lastSyncAt: daysAgo(95) });

    const { rows } = await listStaleDevices(UNSCOPED, NOW);
    expect(serialsOf(rows)).toEqual(["STALE"]);
  });

  test("excludes devices MDM has never reported a sync for", async () => {
    // Null covers "never enrolled", "the export's date would not parse" and —
    // commonly, since the column is newer than the fleet — "no import has
    // filled it in yet". None is "last seen 45 days ago", so none belongs on a
    // chase list.
    await mkItem({ serialNumber: "NEVER", lastSyncAt: null });
    await mkItem({ serialNumber: "STALE", lastSyncAt: daysAgo(45) });

    const { rows } = await listStaleDevices(UNSCOPED, NOW);
    expect(serialsOf(rows)).toEqual(["STALE"]);
  });

  test("reads the SYNC column, not the sign-in column", async () => {
    // The two disagree constantly, which is the whole reason both exist — so a
    // row where they disagree is the only fixture that can tell which one the
    // predicate reads. This list shipped over lastLogonAt and was moved on
    // 2026-08-11; swapping it back would pass every other test in this file.
    await mkItem({ serialNumber: "UNUSED-BUT-ONLINE", lastSyncAt: daysAgo(1), lastLogonAt: daysAgo(45) });
    await mkItem({ serialNumber: "USED-BUT-OFFLINE", lastSyncAt: daysAgo(45), lastLogonAt: daysAgo(1) });

    const { rows } = await listStaleDevices(UNSCOPED, NOW);
    expect(serialsOf(rows)).toEqual(["USED-BUT-OFFLINE"]);
  });

  test("excludes retired kit", async () => {
    await mkItem({ serialNumber: "RETIRED", lastSyncAt: daysAgo(45), status: "RETIRED" });
    await mkItem({ serialNumber: "STALE", lastSyncAt: daysAgo(45) });

    const { rows } = await listStaleDevices(UNSCOPED, NOW);
    expect(serialsOf(rows)).toEqual(["STALE"]);
  });

  test("excludes a device out on an open hand receipt", async () => {
    // MDM silence is EXPECTED for kit deliberately issued out, and the receipt
    // already says who has it.
    const issued = await mkItem({ serialNumber: "ISSUED", lastSyncAt: daysAgo(45) });
    await issueOnOpenReceipt(issued.id, issued.serialNumber);
    await mkItem({ serialNumber: "STALE", lastSyncAt: daysAgo(45) });

    const { rows } = await listStaleDevices(UNSCOPED, NOW);
    expect(serialsOf(rows)).toEqual(["STALE"]);
  });

  test("still includes a device whose receipt is closed or whose line came back", async () => {
    // Custody has ENDED in both shapes, so MDM silence is unexplained again and
    // the device belongs on the list. Either half of the predicate alone would
    // wrongly keep one of these out.
    const returned = await mkItem({ serialNumber: "RETURNED", lastSyncAt: daysAgo(45) });
    await issueOnOpenReceipt(returned.id, returned.serialNumber, { returnedAt: daysAgo(2) });
    const closed = await mkItem({ serialNumber: "CLOSED", lastSyncAt: daysAgo(46) });
    await issueOnOpenReceipt(closed.id, closed.serialNumber, { status: "CLOSED" });

    const { rows } = await listStaleDevices(UNSCOPED, NOW);
    expect(serialsOf(rows).sort()).toEqual(["CLOSED", "RETURNED"]);
  });

  test("treats the window as half-open: 90 days in, 30 days out", async () => {
    await mkItem({ serialNumber: "AT-90", lastSyncAt: daysAgo(STALE_MAX_DAYS) });
    await mkItem({ serialNumber: "AT-30", lastSyncAt: daysAgo(STALE_MIN_DAYS) });

    // Exactly one boundary claims a device landing on it, so a row can never be
    // counted by two windows or by neither.
    const { rows } = await listStaleDevices(UNSCOPED, NOW);
    expect(serialsOf(rows)).toEqual(["AT-90"]);
  });

  test("honours the dashboard's unit scope", async () => {
    await mkItem({ serialNumber: "ALPHA", lastSyncAt: daysAgo(45), deviceUIC: "WAAAAA" });
    await mkItem({ serialNumber: "BRAVO", lastSyncAt: daysAgo(45), deviceUIC: "WBBBBB" });

    const { rows } = await listStaleDevices({ uic: "WAAAAA", unit: null }, NOW);
    expect(serialsOf(rows)).toEqual(["ALPHA"]);
  });

  test("orders stalest first", async () => {
    await mkItem({ serialNumber: "B-40", lastSyncAt: daysAgo(40) });
    await mkItem({ serialNumber: "A-80", lastSyncAt: daysAgo(80) });
    await mkItem({ serialNumber: "C-60", lastSyncAt: daysAgo(60) });

    const { rows } = await listStaleDevices(UNSCOPED, NOW);
    expect(serialsOf(rows)).toEqual(["A-80", "C-60", "B-40"]);
  });
});

describe("listStaleDevices — the exported row", () => {
  test("carries the identity, the holder and the age of the sync", async () => {
    await mkItem({
      serialNumber: "SN-EXPORT",
      deviceName: "LAPTOP-042",
      homeUnit: "Alpha Co",
      deviceUIC: "WAAAAA",
      lastLogonUserPrincipalName: "pfc@army.mil",
      lastSyncAt: daysAgo(45),
      compliance: "noncompliant",
    });

    const { rows } = await listStaleDevices(UNSCOPED, NOW);
    expect(rows[0]).toMatchObject({
      Serial: "SN-EXPORT",
      "Device name": "LAPTOP-042",
      Make: "Dell",
      Model: "5540",
      "Home unit": "Alpha Co",
      UIC: "WAAAAA",
      // Still carried: who MDM last saw on the device is who to ask about it,
      // even though the window now measures the sync rather than the sign-in.
      "Last logon user": "pfc@army.mil",
      // ISO, so a spreadsheet sorts it — and in UTC, so it cannot slip a day.
      "Last sync date": "2026-06-26",
      "Days since sync": 45,
      // Verbatim from the export, not relabelled: the sheet is cross-checked
      // against Intune, and the row's colour is picked from this same value.
      Compliance: "noncompliant",
      // Derived by the same CASE the rest of the app reads, not restated here.
      Readiness: "Deployed",
    });
  });

  test("renders an absent value as blank rather than dropping the column", async () => {
    await mkItem({ serialNumber: "SPARSE", lastSyncAt: daysAgo(45) });

    const { rows } = await listStaleDevices(UNSCOPED, NOW);
    expect(rows[0]).toMatchObject({
      "Device name": "",
      Category: "",
      "Home unit": "",
      Holder: "",
      "Storage location": "",
      "Last logon user": "",
    });
  });
});

describe("countStaleDevices", () => {
  test("counts exactly the rows the export would carry", async () => {
    await mkItem({ lastSyncAt: daysAgo(45) });
    await mkItem({ lastSyncAt: daysAgo(70) });
    await mkItem({ lastSyncAt: daysAgo(10) });
    await mkItem({ lastSyncAt: daysAgo(200) });
    await mkItem({ lastSyncAt: null });
    const issued = await mkItem({ lastSyncAt: daysAgo(50) });
    await issueOnOpenReceipt(issued.id, issued.serialNumber);

    // The card shows this number and the button hands over those rows. They are
    // two round trips through one predicate; if they can disagree, the number
    // on screen is a lie about the file.
    const count = await countStaleDevices(UNSCOPED, NOW);
    const { rows } = await listStaleDevices(UNSCOPED, NOW);
    expect(count).toBe(2);
    expect(rows).toHaveLength(count);
  });

  test("counts within the unit scope", async () => {
    await mkItem({ lastSyncAt: daysAgo(45), deviceUIC: "WAAAAA" });
    await mkItem({ lastSyncAt: daysAgo(45), deviceUIC: "WAAAAA" });
    await mkItem({ lastSyncAt: daysAgo(45), deviceUIC: "WBBBBB" });

    expect(await countStaleDevices({ uic: "WAAAAA", unit: null }, NOW)).toBe(2);
  });
});
