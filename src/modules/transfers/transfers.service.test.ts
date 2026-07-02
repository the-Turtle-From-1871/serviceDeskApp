import { describe, it, expect, vi, beforeEach } from "vitest";

const item = { id: "itm1", make: "Dell", model: "Latitude", serialNumber: "SN123", status: "ACTIVE" };
const created = { id: "t1", receiptNumber: "HR-AAAA1111" };

vi.mock("@/lib/prisma", () => {
  const tx = {
    item: { findUnique: vi.fn(async () => item) },
    transfer: { create: vi.fn(async () => created), findFirst: vi.fn(), findMany: vi.fn() },
  };
  type Tx = typeof tx;
  return {
    default: {
      $transaction: vi.fn(async (fn: (tx: Tx) => unknown) => fn(tx)),
      transfer: {
        findUnique: vi.fn(),
        findFirst: vi.fn(async () => ({ receiverIsDcsim: false, receiverName: "Prev", receiverRank: "PVT", receiverUnit: "B Co", receiverContact: "x", receiverEmail: "p@u.mil" })),
        findMany: vi.fn(async () => [{ id: "t1", item }]),
      },
    },
    __tx: tx,
  };
});

import prisma from "@/lib/prisma";
// @ts-expect-error - __tx is a test-only export added by the vi.mock factory above.
import { __tx } from "@/lib/prisma";
import { createTransfer, searchReceipts, getLastReceiver } from "./transfers.service";
import type { PartyInput } from "./transfers.schema";

const sender = { isDcsim: true, name: "Tech" } as PartyInput;
const receiver = { isDcsim: false, name: "Jane", rank: "SGT", unit: "A Co", contact: "808", email: "j@u.mil" } as PartyInput;
const sig = "data:image/png;base64,AAAA";

beforeEach(() => vi.clearAllMocks());

describe("createTransfer", () => {
  it("writes snapshot columns and a receipt number, status COMPLETED", async () => {
    await createTransfer({ itemId: "itm1", sender, receiver, receiverSignature: sig });
    const call = vi.mocked(__tx.transfer.create).mock.calls[0][0].data;
    expect(call.senderIsDcsim).toBe(true);
    expect(call.senderName).toBe("Tech");
    expect(call.receiverEmail).toBe("j@u.mil");
    expect(call.receiverSignature).toBe(sig);
    expect(call.status).toBe("COMPLETED");
    expect(call.receiptNumber).toMatch(/^HR-[0-9A-F]{8}$/);
    expect(call.itemSummary).toContain("SN123");
  });
});

describe("searchReceipts", () => {
  it("queries by receiptNumber OR item serial", async () => {
    await searchReceipts("SN123");
    const where = vi.mocked(prisma.transfer.findMany).mock.calls[0][0]?.where;
    expect(JSON.stringify(where)).toContain("serialNumber");
    expect(JSON.stringify(where)).toContain("receiptNumber");
  });
});

describe("getLastReceiver", () => {
  it("maps the last receiver snapshot into a PartyInput", async () => {
    const p = await getLastReceiver("itm1");
    expect(p).toEqual({ isDcsim: false, name: "Prev", rank: "PVT", unit: "B Co", contact: "x", email: "p@u.mil" });
  });
});
