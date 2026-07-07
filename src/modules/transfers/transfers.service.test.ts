import { describe, it, expect, vi, beforeEach } from "vitest";

const items = [
  { id: "i1", make: "M4", model: "Carbine", serialNumber: "A1", status: "ACTIVE" },
  { id: "i2", make: "M4", model: "Carbine", serialNumber: "A2", status: "ACTIVE" },
  { id: "i3", make: "AN/PVS", model: "14", serialNumber: "B7", status: "ACTIVE" },
];
const created = { id: "t1", receiptNumber: "HR-000042" };

vi.mock("@/lib/prisma", () => {
  const tx = {
    item: { findMany: vi.fn(async () => items) },
    transfer: { create: vi.fn(async () => created) },
    $queryRaw: vi.fn(async () => [{ n: BigInt(42) }]),
  };
  type Tx = typeof tx;
  return {
    default: {
      $transaction: vi.fn(async (fn: (tx: Tx) => unknown) => fn(tx)),
      transfer: {
        findUnique: vi.fn(),
        findFirst: vi.fn(async () => ({ receiverIsDcsim: false, receiverName: "Prev", receiverRank: "PVT", receiverUnit: "B Co", receiverContact: "x", receiverEmail: "p@u.mil" })),
        findMany: vi.fn(async () => []),
      },
    },
    __tx: tx,
  };
});

// @ts-expect-error test-only export
import { __tx } from "@/lib/prisma";
import prisma from "@/lib/prisma";
import { createTransfer, getLastReceiver } from "./transfers.service";
import type { PartyInput, LineQtyInput } from "./transfers.schema";

const sender = { isDcsim: true, name: "Tech" } as PartyInput;
const receiver = { isDcsim: false, name: "Jane", rank: "SGT", unit: "A Co", contact: "808", email: "j@u.mil" } as PartyInput;
const sig = "data:image/png;base64,AAAA";
const lines: LineQtyInput[] = [
  { make: "M4", model: "Carbine", qtyAuth: 2, qtyIssued: 2 },
  { make: "AN/PVS", model: "14", qtyAuth: 1, qtyIssued: 1 },
];

beforeEach(() => vi.clearAllMocks());

describe("createTransfer (multi-item)", () => {
  it("creates nested lines + items with matched quantities and a receipt number", async () => {
    await createTransfer({ itemIds: ["i1", "i2", "i3"], lines, sender, receiver, receiverSignature: sig });
    const data = vi.mocked(__tx.transfer.create).mock.calls[0][0].data;
    expect(data.receiptNumber).toBe("HR-000042");
    expect(data.itemSummary).toContain("A1");
    const created = data.lines.create;
    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({ lineNo: 1, make: "M4", model: "Carbine", qtyAuth: 2, qtyIssued: 2 });
    expect(created[0].items.create).toEqual([
      { itemId: "i1", serialNumber: "A1" },
      { itemId: "i2", serialNumber: "A2" },
    ]);
    expect(created[1]).toMatchObject({ lineNo: 2, make: "AN/PVS", model: "14", qtyAuth: 1, qtyIssued: 1 });
  });

  it("rejects more than 10 items in one make+model row", async () => {
    const many = Array.from({ length: 11 }, (_, n) => ({ id: `x${n}`, make: "M4", model: "Carbine", serialNumber: `S${n}`, status: "ACTIVE" }));
    vi.mocked(__tx.item.findMany).mockResolvedValueOnce(many);
    await expect(createTransfer({
      itemIds: many.map((m) => m.id),
      lines: [{ make: "M4", model: "Carbine", qtyAuth: 11, qtyIssued: 11 }],
      sender, receiver, receiverSignature: sig,
    })).rejects.toThrow("TOO_MANY_PER_ROW");
  });

  it("rejects when an item is retired", async () => {
    vi.mocked(__tx.item.findMany).mockResolvedValueOnce([{ ...items[0], status: "RETIRED" }, items[1], items[2]]);
    await expect(createTransfer({ itemIds: ["i1", "i2", "i3"], lines, sender, receiver, receiverSignature: sig }))
      .rejects.toThrow("ITEM_RETIRED");
  });

  it("rejects when an item id is missing", async () => {
    vi.mocked(__tx.item.findMany).mockResolvedValueOnce([items[0]]);
    await expect(createTransfer({ itemIds: ["i1", "i2", "i3"], lines, sender, receiver, receiverSignature: sig }))
      .rejects.toThrow("ITEM_NOT_FOUND");
  });

  it("dedupes a repeated itemId so one physical item appears once", async () => {
    // Real Prisma `findMany({ where: { id: { in: itemIds } } })` collapses duplicate
    // ids to distinct rows, so mock it that way here (unlike the default mock, which
    // ignores its input and always returns all three fixture items).
    vi.mocked(__tx.item.findMany).mockResolvedValueOnce([items[0], items[2]]);
    const dedupeLines: LineQtyInput[] = [
      { make: "M4", model: "Carbine", qtyAuth: 1, qtyIssued: 1 },
      { make: "AN/PVS", model: "14", qtyAuth: 1, qtyIssued: 1 },
    ];
    await createTransfer({ itemIds: ["i1", "i1", "i3"], lines: dedupeLines, sender, receiver, receiverSignature: sig });
    const data = vi.mocked(__tx.transfer.create).mock.calls[0][0].data;
    const created = data.lines.create;
    const m4Line = created.find((l) => l.make === "M4")!;
    expect(m4Line.items.create).toEqual([{ itemId: "i1", serialNumber: "A1" }]);
    expect(m4Line.qtyAuth).toBe(1);
    expect(m4Line.qtyIssued).toBe(1);
  });
});

describe("getLastReceiver", () => {
  it("maps the last receiver snapshot into a PartyInput", async () => {
    const p = await getLastReceiver("itm1");
    expect(p).toEqual({ isDcsim: false, name: "Prev", rank: "PVT", unit: "B Co", contact: "x", email: "p@u.mil" });
  });

  it("maps null receiver snapshot fields to undefined for a DCSIM receiver", async () => {
    vi.mocked(prisma.transfer.findFirst).mockResolvedValueOnce({
      receiverIsDcsim: true,
      receiverName: "DCSIM Tech",
      receiverRank: null,
      receiverUnit: null,
      receiverContact: null,
      receiverEmail: null,
    } as Awaited<ReturnType<typeof prisma.transfer.findFirst>>);
    const p = await getLastReceiver("itm1");
    expect(p).toEqual({
      isDcsim: true,
      name: "DCSIM Tech",
      rank: undefined,
      unit: undefined,
      contact: undefined,
      email: undefined,
    });
  });
});
