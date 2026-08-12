import { describe, it, expect, beforeAll, afterAll } from "vitest";
import prisma from "@/lib/prisma";
import { resetDb } from "../../../tests/helpers/db";
import { readinessForItems } from "@/modules/items/readiness.query";
import { holdersForItems } from "./holders.query";

/** States live custody can legitimately produce. RETIRED and IN_REPAIR
 *  outrank the open-receipt DEPLOYED branch in READINESS_CASE
 *  (src/modules/items/readiness.sql.ts), so an item present in the holders
 *  map is not guaranteed to read DEPLOYED — see the "uses the same custody
 *  rule" test below. */
const CUSTODY_READINESS_STATES = ["DEPLOYED", "IN_REPAIR", "RETIRED"];

const PREFIX = "HOLDERQ-";
const JAN = new Date("2026-01-01T00:00:00Z");
const JUN = new Date("2026-06-01T00:00:00Z");

const ids: Record<string, string> = {};

/** Seed one item plus, optionally, one receipt holding it. */
async function seed(
  key: string,
  adminId: string,
  receipt?: { receiverName: string; closed?: boolean; returned?: boolean; createdAt?: Date },
) {
  const item = await prisma.item.create({
    data: {
      make: "Dell", model: "5540", serialNumber: `${PREFIX}${key}`, createdById: adminId,
    },
  });
  ids[key] = item.id;
  if (receipt) {
    await prisma.transfer.create({
      data: {
        receiptNumber: `${PREFIX}R-${key}-${receipt.receiverName}`,
        itemSummary: "x", senderName: "s", receiverName: receipt.receiverName,
        receiverSignature: "",
        status: receipt.closed ? "CLOSED" : "OPEN",
        closedAt: receipt.closed ? JUN : null,
        createdAt: receipt.createdAt ?? JAN,
        lines: {
          create: [{
            lineNo: 1, make: "Dell", model: "5540", qtyAuth: 1, qtyIssued: 1,
            items: {
              create: [{
                itemId: item.id,
                serialNumber: `${PREFIX}${key}`,
                returnedAt: receipt.returned ? JUN : null,
              }],
            },
          }],
        },
      },
    });
  }
  return item.id;
}

beforeAll(async () => {
  await resetDb();
  const admin = await prisma.user.create({
    data: { name: "Holders", email: "holders@x.co", passwordHash: "x", role: "ADMIN" },
  });
  await seed("OPEN", admin.id, { receiverName: "Jane Doe" });
  await seed("CLOSED", admin.id, { receiverName: "Ellen Doe", closed: true });
  await seed("RETURNED", admin.id, { receiverName: "Frank Doe", returned: true });
  await seed("NONE", admin.id);
  // Live custody (an open, unreturned receipt) AND flagged for service. The
  // service-queue rule outranks the open-receipt rule in READINESS_CASE, so
  // this item belongs in the holders map (it has live custody) but must NOT
  // read DEPLOYED — it reads IN_REPAIR. Mirrors the seed shape in
  // items.readiness-sort.parity.test.ts (seed 09: flagged + onOpenReceipt).
  await seed("FLAGGED", admin.id, { receiverName: "Grace Doe" });
  await prisma.serviceQueueItem.create({
    data: { itemId: ids.FLAGGED, serviceType: "REPAIR", status: "PENDING" },
  });
  // Two live receipts for one device: the map holds ONE name, the newer.
  await seed("TWO", admin.id, { receiverName: "Older Holder", createdAt: JAN });
  await prisma.transfer.create({
    data: {
      receiptNumber: `${PREFIX}R-TWO-NEWER`, itemSummary: "x", senderName: "s",
      receiverName: "Newer Holder", receiverSignature: "", status: "OPEN", createdAt: JUN,
      lines: {
        create: [{
          lineNo: 1, make: "Dell", model: "5540", qtyAuth: 1, qtyIssued: 1,
          items: { create: [{ itemId: ids.TWO, serialNumber: `${PREFIX}TWO` }] },
        }],
      },
    },
  });
});

afterAll(async () => {
  await resetDb();
});

describe("holdersForItems", () => {
  it("returns the recipient of an open, unreturned receipt", async () => {
    expect((await holdersForItems([ids.OPEN])).get(ids.OPEN)).toBe("Jane Doe");
  });

  it("omits an item whose receipt is closed — custody has ended", async () => {
    expect((await holdersForItems([ids.CLOSED])).has(ids.CLOSED)).toBe(false);
  });

  it("omits an item whose row was returned, even on an open receipt", async () => {
    expect((await holdersForItems([ids.RETURNED])).has(ids.RETURNED)).toBe(false);
  });

  it("omits an item that was never hand-receipted", async () => {
    expect((await holdersForItems([ids.NONE])).has(ids.NONE)).toBe(false);
  });

  it("returns ONE name for an item on two open receipts — the newer", async () => {
    // DISTINCT ON is what stops a second receipt duplicating a table row.
    const map = await holdersForItems([ids.TWO]);
    expect(map.get(ids.TWO)).toBe("Newer Holder");
  });

  it("answers for a whole page in one query, and returns an empty map for no ids", async () => {
    const map = await holdersForItems(Object.values(ids));
    expect(map.get(ids.OPEN)).toBe("Jane Doe");
    expect(map.size).toBe(3); // OPEN, TWO, and FLAGGED; the other three have no live custody
    expect((await holdersForItems([])).size).toBe(0);
  });

  it("uses the same custody rule the readiness derivation uses — but custody alone does not guarantee DEPLOYED", async () => {
    // The point of custody.sql.ts: an item is "held" for the Holder column
    // exactly when it sits on an open, unreturned receipt — the SAME predicate
    // READINESS_CASE embeds in its DEPLOYED-by-receipt branch. These two agreed
    // by coincidence when the predicate was written out twice; they agree by
    // construction now.
    //
    // That does NOT mean every item in the holders map reads DEPLOYED: RETIRED
    // and IN_REPAIR (a PENDING ServiceQueueItem) outrank the open-receipt
    // branch in READINESS_CASE (src/modules/items/readiness.sql.ts), so a
    // device turned in for repair while still on an open receipt correctly
    // reads IN_REPAIR, not Deployed (CLAUDE.md; also exercised end to end by
    // items.readiness-sort.parity.test.ts, seed 09). FLAGGED is exactly that
    // shape: live custody (present in the holders map) AND a PENDING
    // ServiceQueueItem, so readiness must rank it IN_REPAIR.
    const map = await holdersForItems(Object.values(ids));
    const states = await readinessForItems(Object.values(ids));
    // A map that happened to be empty would satisfy every assertion inside the
    // loop below by never entering it, so assert non-emptiness and the ids
    // this test actually depends on before relying on the loop.
    expect(map.size).toBeGreaterThan(0);
    expect(map.has(ids.OPEN)).toBe(true);
    expect(map.has(ids.FLAGGED)).toBe(true);
    expect(states.get(ids.FLAGGED)).toBe("IN_REPAIR");
    for (const [key, id] of Object.entries(ids)) {
      if (map.has(id)) {
        expect([key, CUSTODY_READINESS_STATES.includes(states.get(id) ?? "")]).toEqual([key, true]);
      }
    }
  });
});
