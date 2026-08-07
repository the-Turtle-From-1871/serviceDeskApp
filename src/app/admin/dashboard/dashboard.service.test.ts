import { describe, it, expect, beforeAll } from "vitest";
import prisma from "@/lib/prisma";
import { resetDb, migrateTestDb } from "../../../../tests/helpers/db";
import { getRecentReceipts, RECENT_RECEIPT_COUNT } from "./dashboard.service";

const PREFIX = "RECENT-";
const AT = (day: number) => new Date(`2026-03-${String(day).padStart(2, "0")}T12:00:00Z`);

/** A receipt with no lines — this query never joins them, so the shape is enough. */
async function seedReceipt(key: string, createdAt: Date, opts: { closed?: boolean; receiverName?: string } = {}) {
  await prisma.transfer.create({
    data: {
      receiptNumber: `${PREFIX}${key}`,
      itemSummary: `summary ${key}`,
      senderName: "Desk",
      receiverName: opts.receiverName ?? `Recipient ${key}`,
      // A realistic non-empty blob: the point of the `select` is that this never
      // leaves the database, so an empty string here would not prove anything.
      receiverSignature: `data:image/png;base64,${"A".repeat(512)}`,
      status: opts.closed ? "CLOSED" : "OPEN",
      closedAt: opts.closed ? createdAt : null,
      createdAt,
    },
  });
}

beforeAll(async () => {
  migrateTestDb();
  await resetDb();
  // Seeded out of chronological order so a passing ordering test cannot be an
  // artifact of insertion order.
  await seedReceipt("03", AT(3), { closed: true });
  await seedReceipt("01", AT(1));
  await seedReceipt("05", AT(5), { receiverName: "Jane Doe" });
  await seedReceipt("02", AT(2));
  await seedReceipt("04", AT(4), { closed: true });
});

describe("getRecentReceipts", () => {
  it("returns the newest receipts first", async () => {
    const rows = await getRecentReceipts();
    expect(rows.map((r) => r.receiptNumber)).toEqual([
      `${PREFIX}05`,
      `${PREFIX}04`,
      `${PREFIX}03`,
      `${PREFIX}02`,
      `${PREFIX}01`,
    ]);
  });

  it("caps the result at the requested limit", async () => {
    const rows = await getRecentReceipts(2);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.receiptNumber)).toEqual([`${PREFIX}05`, `${PREFIX}04`]);
  });

  it("includes both open and closed receipts, with the status carried through", async () => {
    const rows = await getRecentReceipts();
    const byNumber = new Map(rows.map((r) => [r.receiptNumber, r.status]));
    expect(byNumber.get(`${PREFIX}05`)).toBe("OPEN");
    expect(byNumber.get(`${PREFIX}04`)).toBe("CLOSED");
    // Both states present — a filter creeping in would collapse one of these.
    expect(new Set(rows.map((r) => r.status))).toEqual(new Set(["OPEN", "CLOSED"]));
  });

  it("never selects the signature blob or party PII beyond the recipient name", async () => {
    const rows = await getRecentReceipts();
    // The card renders exactly these five fields. Anything else means the
    // `select` was widened — and `receiverSignature` is a base64 PNG per row.
    expect(Object.keys(rows[0]).sort()).toEqual([
      "createdAt",
      "itemSummary",
      "receiptNumber",
      "receiverName",
      "status",
    ]);
    expect(JSON.stringify(rows)).not.toContain("data:image");
  });

  it("serialises createdAt as an ISO string for the client boundary", async () => {
    const [newest] = await getRecentReceipts(1);
    expect(newest.createdAt).toBe(AT(5).toISOString());
  });

  it("defaults to the documented card size", async () => {
    expect(RECENT_RECEIPT_COUNT).toBe(10);
    // Fewer rows than the cap must not pad or throw.
    await expect(getRecentReceipts()).resolves.toHaveLength(5);
  });
});
