import { describe, it, expect, beforeAll, afterAll } from "vitest";
import prisma from "@/lib/prisma";
import { resetDb, migrateTestDb } from "../../../tests/helpers/db";
import { readinessForItems } from "@/modules/items/readiness.query";
import { holdersForItems } from "./holders.query";

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
  migrateTestDb();
  await resetDb();
  const admin = await prisma.user.create({
    data: { name: "Holders", email: "holders@x.co", passwordHash: "x", role: "ADMIN" },
  });
  await seed("OPEN", admin.id, { receiverName: "Jane Doe" });
  await seed("CLOSED", admin.id, { receiverName: "Ellen Doe", closed: true });
  await seed("RETURNED", admin.id, { receiverName: "Frank Doe", returned: true });
  await seed("NONE", admin.id);
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
    expect(map.size).toBe(2); // OPEN and TWO; the other three have no live custody
    expect((await holdersForItems([])).size).toBe(0);
  });

  it("uses the same custody rule the readiness derivation uses", async () => {
    // The point of custody.sql.ts: an item is "held" for the Holder column
    // exactly when readiness calls it DEPLOYED-by-receipt. These two agreed by
    // coincidence when the predicate was written out twice; they agree by
    // construction now, and this asserts it end to end.
    const map = await holdersForItems(Object.values(ids));
    const states = await readinessForItems(Object.values(ids));
    for (const [key, id] of Object.entries(ids)) {
      if (map.has(id)) {
        expect([key, states.get(id)]).toEqual([key, "DEPLOYED"]);
      }
    }
  });
});
