import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => {
  const tx = {
    serviceQueueItem: { findUnique: vi.fn(), update: vi.fn(), upsert: vi.fn() },
  };
  type Tx = typeof tx;
  return {
    default: {
      $transaction: vi.fn(async (fn: (tx: Tx) => unknown) => fn(tx)),
      serviceQueueItem: {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(),
        upsert: vi.fn(async () => ({ id: "sq1", status: "PENDING" })),
        delete: vi.fn(async () => ({})),
      },
    },
    __tx: tx,
  };
});

// @ts-expect-error test-only export
import { __tx } from "@/lib/prisma";
import prisma from "@/lib/prisma";
import {
  upsertServiceRequest,
  clearServiceRequest,
  completeServiceItem,
  reopenServiceItem,
  listActiveQueue,
  getServiceRequestForItem,
} from "./service-queue.service";
import { ServiceQueueError } from "./service-queue.errors";

beforeEach(() => vi.clearAllMocks());

describe("upsertServiceRequest", () => {
  it("upserts a PENDING row keyed by itemId", async () => {
    await upsertServiceRequest({ itemId: "i1", serviceType: "REPAIR", transferId: "t1" });
    const arg = vi.mocked(prisma.serviceQueueItem.upsert).mock.calls[0][0];
    expect(arg.where).toEqual({ itemId: "i1" });
    expect(arg.create).toMatchObject({ itemId: "i1", serviceType: "REPAIR", transferId: "t1", status: "PENDING", serviceNote: null });
    expect(arg.update).toMatchObject({ serviceType: "REPAIR", transferId: "t1", status: "PENDING", serviceNote: null });
  });

  it("rejects OTHER without a note", async () => {
    await expect(upsertServiceRequest({ itemId: "i1", serviceType: "OTHER", note: "  " }))
      .rejects.toMatchObject({ code: "NOTE_REQUIRED" });
    expect(prisma.serviceQueueItem.upsert).not.toHaveBeenCalled();
  });

  it("keeps the trimmed note for OTHER", async () => {
    await upsertServiceRequest({ itemId: "i1", serviceType: "OTHER", note: " dead battery " });
    const arg = vi.mocked(prisma.serviceQueueItem.upsert).mock.calls[0][0];
    expect(arg.create.serviceNote).toBe("dead battery");
  });

  it("stamps dueAt from the type default and resets overdueAlertedAt on update", async () => {
    await upsertServiceRequest({ itemId: "i1", serviceType: "REPAIR", transferId: "t1" });
    const arg = vi.mocked(prisma.serviceQueueItem.upsert).mock.calls[0][0];
    expect(arg.create.dueAt).toBeInstanceOf(Date);
    expect(arg.update.dueAt).toBeInstanceOf(Date);
    expect(arg.update.overdueAlertedAt).toBeNull();
    expect(arg.create.overdueAlertedAt ?? null).toBeNull();
  });

  it("honors an override days value for dueAt", async () => {
    const before = Date.now();
    await upsertServiceRequest({ itemId: "i1", serviceType: "REPAIR", overrideDays: 1 });
    const arg = vi.mocked(prisma.serviceQueueItem.upsert).mock.calls[0][0];
    const dueAt = arg.create.dueAt as Date;
    const days = Math.round((dueAt.getTime() - before) / (24 * 60 * 60 * 1000));
    expect(days).toBe(1);
  });
});

describe("clearServiceRequest", () => {
  it("deletes the item's row", async () => {
    await clearServiceRequest("i1");
    expect(prisma.serviceQueueItem.delete).toHaveBeenCalledWith({ where: { itemId: "i1" } });
  });
});

describe("completeServiceItem", () => {
  it("PENDING -> COMPLETED", async () => {
    vi.mocked(__tx.serviceQueueItem.findUnique).mockResolvedValueOnce({ id: "sq1", status: "PENDING" });
    vi.mocked(__tx.serviceQueueItem.update).mockResolvedValueOnce({ id: "sq1", status: "COMPLETED" });
    const r = await completeServiceItem("sq1");
    expect(__tx.serviceQueueItem.update).toHaveBeenCalledWith({ where: { id: "sq1" }, data: { status: "COMPLETED" } });
    expect(r.status).toBe("COMPLETED");
  });

  it("throws INVALID_STATUS when already completed", async () => {
    vi.mocked(__tx.serviceQueueItem.findUnique).mockResolvedValueOnce({ id: "sq1", status: "COMPLETED" });
    await expect(completeServiceItem("sq1")).rejects.toBeInstanceOf(ServiceQueueError);
  });

  it("throws NOT_FOUND when missing", async () => {
    vi.mocked(__tx.serviceQueueItem.findUnique).mockResolvedValueOnce(null);
    await expect(completeServiceItem("nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("reopenServiceItem", () => {
  it("COMPLETED -> PENDING", async () => {
    vi.mocked(__tx.serviceQueueItem.findUnique).mockResolvedValueOnce({ id: "sq1", status: "COMPLETED" });
    vi.mocked(__tx.serviceQueueItem.update).mockResolvedValueOnce({ id: "sq1", status: "PENDING" });
    const r = await reopenServiceItem("sq1");
    expect(__tx.serviceQueueItem.update).toHaveBeenCalledWith({ where: { id: "sq1" }, data: { status: "PENDING" } });
    expect(r.status).toBe("PENDING");
  });
});

describe("listActiveQueue", () => {
  it("queries PENDING rows with item + transfer includes", async () => {
    await listActiveQueue();
    const arg = vi.mocked(prisma.serviceQueueItem.findMany).mock.calls[0][0];
    expect(arg.where).toEqual({ status: "PENDING" });
    expect(arg.include.item.select).toMatchObject({ serialNumber: true, deviceName: true, homeUnit: true });
    expect(arg.include.transfer.select).toMatchObject({ receiptNumber: true });
  });
});

describe("getServiceRequestForItem", () => {
  it("finds the item's row by itemId with the transfer's receiptNumber included", async () => {
    vi.mocked(prisma.serviceQueueItem.findUnique).mockResolvedValueOnce({ id: "sq1", itemId: "i1", status: "PENDING" });
    await getServiceRequestForItem("i1");
    const arg = vi.mocked(prisma.serviceQueueItem.findUnique).mock.calls[0][0];
    expect(arg.where).toEqual({ itemId: "i1" });
    expect(arg.include.transfer.select).toEqual({ receiptNumber: true });
  });
});
