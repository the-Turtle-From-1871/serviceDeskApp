import { beforeEach, describe, expect, it, vi } from "vitest";

const { transfer, prismaMock } = vi.hoisted(() => {
  const transfer = { findMany: vi.fn() };
  return { transfer, prismaMock: { transfer } };
});
vi.mock("@/lib/prisma", () => ({ default: prismaMock, prisma: prismaMock }));

import { listReceipts } from "./transfers.service";

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `t${i}`,
    receiptNumber: `HR-00000${i}`,
    itemSummary: "Laptop",
    createdAt: new Date(),
    status: "OPEN",
    senderName: "Desk",
    receiverName: "Jane",
  }));

beforeEach(() => {
  vi.clearAllMocks();
  transfer.findMany.mockResolvedValue([]);
});

describe("listReceipts — scoping", () => {
  it("filters to the viewer's own receipts when they cannot see all", async () => {
    await listReceipts({ viewerEmail: "jane@unit.mil", all: false });
    const where = transfer.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([
      { senderEmail: { equals: "jane@unit.mil", mode: "insensitive" } },
      { receiverEmail: { equals: "jane@unit.mil", mode: "insensitive" } },
    ]);
  });

  it("applies no party filter when the viewer holds VIEW_ALL_RECEIPTS", async () => {
    await listReceipts({ viewerEmail: "jane@unit.mil", all: true });
    expect(transfer.findMany.mock.calls[0][0].where?.OR).toBeUndefined();
  });

  // THE guard. An account with no verified address must see NOTHING, never
  // everything: falling through to an unfiltered query would hand the entire
  // property book to precisely the accounts this scoping exists to restrict.
  it("returns nothing — never everything — when there is no viewer email", async () => {
    const res = await listReceipts({ viewerEmail: null, all: false });
    expect(res).toEqual({ rows: [], nextCursor: null });
    expect(transfer.findMany).not.toHaveBeenCalled();
  });

  it("still returns everything for an all-viewer with no email of their own", async () => {
    await listReceipts({ viewerEmail: null, all: true });
    expect(transfer.findMany).toHaveBeenCalledTimes(1);
  });
});

describe("listReceipts — shape", () => {
  it("never selects the signature blob or party PII beyond names", async () => {
    await listReceipts({ viewerEmail: "j@x.mil", all: true });
    const select = JSON.stringify(transfer.findMany.mock.calls[0][0].select);
    expect(select).not.toMatch(/signature/i);
    expect(select).not.toMatch(/senderEmail|receiverEmail|Contact/);
  });

  it("is bounded and ordered deterministically", async () => {
    await listReceipts({ viewerEmail: "j@x.mil", all: true });
    const arg = transfer.findMany.mock.calls[0][0];
    expect(arg.take).toBeGreaterThan(0);
    // Two keys: createdAt alone is not unique, and a keyset cursor over a
    // non-unique order can skip or repeat rows at a page boundary.
    expect(arg.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
  });

  it("reports a next cursor only when there is another page", async () => {
    transfer.findMany.mockResolvedValue(rows(26)); // take + 1
    const res = await listReceipts({ viewerEmail: "j@x.mil", all: true, take: 25 });
    expect(res.rows).toHaveLength(25);
    expect(res.nextCursor).toBe("t24");
  });

  it("reports no next cursor on the last page", async () => {
    transfer.findMany.mockResolvedValue(rows(10));
    const res = await listReceipts({ viewerEmail: "j@x.mil", all: true, take: 25 });
    expect(res.rows).toHaveLength(10);
    expect(res.nextCursor).toBeNull();
  });

  it("skips the cursor row itself so a page boundary does not repeat one", async () => {
    await listReceipts({ viewerEmail: "j@x.mil", all: true, cursor: "t5" });
    const arg = transfer.findMany.mock.calls[0][0];
    expect(arg.cursor).toEqual({ id: "t5" });
    expect(arg.skip).toBe(1);
  });
});
