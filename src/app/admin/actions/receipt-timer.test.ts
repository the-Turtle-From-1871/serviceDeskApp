import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/authz", () => ({ requireAdmin: vi.fn(async () => ({ id: "u1", role: "ADMIN" })) }));
vi.mock("@/lib/prisma", () => ({
  default: { transfer: { findUnique: vi.fn(), update: vi.fn(async () => ({})) } },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import prisma from "@/lib/prisma";
import { setReceiptDueAtAction } from "./receipt-timer";

const openRow = { id: "t1", receiptNumber: "HR-000001", status: "OPEN", closedAt: null };

function form(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

beforeEach(() => vi.clearAllMocks());

describe("setReceiptDueAtAction", () => {
  it("sets a new deadline and clears overdueAlertedAt on an open receipt", async () => {
    vi.mocked(prisma.transfer.findUnique).mockResolvedValueOnce(openRow as never);
    const res = await setReceiptDueAtAction(undefined, form({ receiptNumber: "HR-000001", returnDays: "14" }));
    expect(res).toEqual({ ok: true });
    const arg = vi.mocked(prisma.transfer.update).mock.calls[0][0];
    expect(arg.where).toEqual({ id: "t1" });
    expect(arg.data.dueAt).toBeInstanceOf(Date);
    expect(arg.data.overdueAlertedAt).toBeNull();
  });

  it("clears the timer when returnDays is blank", async () => {
    vi.mocked(prisma.transfer.findUnique).mockResolvedValueOnce(openRow as never);
    await setReceiptDueAtAction(undefined, form({ receiptNumber: "HR-000001", returnDays: "" }));
    expect(vi.mocked(prisma.transfer.update).mock.calls[0][0].data.dueAt).toBeNull();
  });

  it("rejects editing a closed receipt", async () => {
    vi.mocked(prisma.transfer.findUnique).mockResolvedValueOnce({ ...openRow, status: "CLOSED", closedAt: new Date() } as never);
    const res = await setReceiptDueAtAction(undefined, form({ receiptNumber: "HR-000001", returnDays: "14" }));
    expect(res.error).toBeTruthy();
    expect(prisma.transfer.update).not.toHaveBeenCalled();
  });

  it("returns an error when the receipt is missing", async () => {
    vi.mocked(prisma.transfer.findUnique).mockResolvedValueOnce(null);
    const res = await setReceiptDueAtAction(undefined, form({ receiptNumber: "HR-NOPE", returnDays: "14" }));
    expect(res.error).toBeTruthy();
  });
});
