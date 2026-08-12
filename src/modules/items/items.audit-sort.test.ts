import { describe, it, expect, beforeAll, afterAll } from "vitest";
import prisma from "@/lib/prisma";
import { resetDb } from "../../../tests/helpers/db";
import { listItems } from "./items.service";
import { auditState, AUDIT_ORDER } from "@/modules/audit/audit.status";

/**
 * The `/items` Audit sort orders by BADGE SEVERITY, and a secondary key orders
 * rows WITHIN a badge.
 *
 * WHY THIS FILE EXISTS: the Audit column displays a three-value badge
 * (compliant / overdue / never) but used to sort by the raw `lastAuditedAt`
 * timestamp. A timestamp is very nearly unique per row, so there were no ties
 * for a secondary key to break and the secondary control silently did nothing —
 * measured against production, all 31 audited rows carried 31 DISTINCT stamps,
 * so a secondary key could not move any of them.
 *
 * The existing parity fixture could never catch it: its rows share two date
 * CONSTANTS (JAN/JUN), so they tie exactly and the secondary appears to work.
 * Every row below therefore carries a DISTINCT timestamp, which is the shape
 * the real catalogue has.
 */

const PREFIX = "AUDITSORT-";
const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const ago = (days: number) => new Date(now - days * DAY);

/* Names are deliberately scrambled against the timestamps: ordering by
   lastAuditedAt does NOT produce alphabetical order in any badge, so a test
   that passes can only be ordering by deviceName. */
type Seed = { serial: string; deviceName: string; lastAuditedAt: Date | null };
const SEEDS: Seed[] = [
  // Compliant — audited inside the 1-year window, three distinct stamps.
  { serial: `${PREFIX}C1`, deviceName: "Alpha", lastAuditedAt: ago(10) },
  { serial: `${PREFIX}C2`, deviceName: "Zulu", lastAuditedAt: ago(20) },
  { serial: `${PREFIX}C3`, deviceName: "Mike", lastAuditedAt: ago(30) },
  // Overdue — audited beyond the window, three distinct stamps.
  { serial: `${PREFIX}O1`, deviceName: "Bravo", lastAuditedAt: ago(400) },
  { serial: `${PREFIX}O2`, deviceName: "Yankee", lastAuditedAt: ago(500) },
  { serial: `${PREFIX}O3`, deviceName: "November", lastAuditedAt: ago(600) },
  // Never audited — the one group that DID tie under the old behaviour.
  { serial: `${PREFIX}N1`, deviceName: "Charlie", lastAuditedAt: null },
  { serial: `${PREFIX}N2`, deviceName: "Xray", lastAuditedAt: null },
  { serial: `${PREFIX}N3`, deviceName: "Oscar", lastAuditedAt: null },
];

beforeAll(async () => {
  await resetDb();
  const admin = await prisma.user.create({
    data: { name: "Audit Sort", email: "audit-sort@x.co", passwordHash: "x", role: "ADMIN" },
  });
  for (const s of SEEDS) {
    await prisma.item.create({
      data: {
        make: "Dell",
        model: "5540",
        serialNumber: s.serial,
        deviceName: s.deviceName,
        lastAuditedAt: s.lastAuditedAt,
        createdById: admin.id,
      },
    });
  }
});

afterAll(async () => {
  await resetDb();
});

/** The rendered badge for each returned row, in order. */
const badgesOf = (items: { lastAuditedAt: Date | null }[]) =>
  items.map((it) => auditState(it.lastAuditedAt, new Date()));

const rowsOf = async (sort: string, dir: "asc" | "desc") =>
  (await listItems({ sort, dir, pageSize: 100 })).items;

describe("audit-status sort", () => {
  it("groups rows by badge in AUDIT_ORDER, not by raw recency", async () => {
    const badges = badgesOf(await rowsOf("auditState", "asc"));
    // Each badge appears as ONE contiguous run, and the runs follow AUDIT_ORDER.
    const runs = badges.filter((b, i) => b !== badges[i - 1]);
    expect(runs).toEqual([...AUDIT_ORDER]);
  });

  it("orders rows WITHIN a badge by the secondary key", async () => {
    const items = await rowsOf("auditState,deviceName", "asc");
    const byBadge = new Map<string, string[]>();
    for (const it of items) {
      const badge = auditState(it.lastAuditedAt, new Date());
      byBadge.set(badge, [...(byBadge.get(badge) ?? []), it.deviceName ?? ""]);
    }
    // This is the regression: under a raw-timestamp sort every one of these
    // groups came back in stamp order, which is NOT alphabetical for any of them.
    expect(byBadge.get("compliant")).toEqual(["Alpha", "Mike", "Zulu"]);
    expect(byBadge.get("overdue")).toEqual(["Bravo", "November", "Yankee"]);
    expect(byBadge.get("never")).toEqual(["Charlie", "Oscar", "Xray"]);
  });

  it("reverses the badge grouping for desc while the secondary stays ascending", async () => {
    const items = (await listItems({ sort: "auditState,deviceName", dir: "desc,asc", pageSize: 100 })).items;
    const badges = badgesOf(items);
    const runs = badges.filter((b, i) => b !== badges[i - 1]);
    expect(runs).toEqual([...AUDIT_ORDER].reverse());
    // The secondary keeps its OWN direction — dir is a parallel list, not one
    // flag for the whole ORDER BY.
    const never = items.filter((it) => it.lastAuditedAt === null).map((it) => it.deviceName);
    expect(never).toEqual(["Charlie", "Oscar", "Xray"]);
  });

  it("pages an audit sort without dropping or duplicating a row", async () => {
    const paged: string[] = [];
    for (let page = 1; page <= 3; page++) {
      const { items } = await listItems({ sort: "auditState", dir: "asc", page, pageSize: 4 });
      paged.push(...items.map((it) => it.serialNumber));
    }
    expect(new Set(paged).size).toBe(SEEDS.length);
  });
});
