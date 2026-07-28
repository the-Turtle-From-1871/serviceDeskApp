import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => {
  const tx = {
    serviceQueueItem: { findUnique: vi.fn(), update: vi.fn(), upsert: vi.fn() },
    // Completing a queue item also stamps the ITEM's markedReadyAt in the same
    // transaction, so the stub needs the item delegate too.
    item: { updateMany: vi.fn(async () => ({ count: 1 })) },
  };
  type Tx = typeof tx;
  return {
    default: {
      $transaction: vi.fn(async (fn: (tx: Tx) => unknown) => fn(tx)),
      serviceQueueItem: {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(),
        upsert: vi.fn(async () => ({ id: "sq1", status: "PENDING" })),
        updateMany: vi.fn(async () => ({ count: 1 })),
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
  setServiceDeadline,
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

  it("CREATES with dueAt = null when no days are given (blank still means no deadline)", async () => {
    // A blank SLA field means NO deadline on a brand-new flag. It must NOT be
    // back-filled with a per-service-type default — an unasked-for deadline
    // shows up as an overdue email and an "Overdue Nd" badge for work that
    // never had one.
    await upsertServiceRequest({ itemId: "i1", serviceType: "REPAIR", transferId: "t1" });
    const arg = vi.mocked(prisma.serviceQueueItem.upsert).mock.calls[0][0];
    expect(arg.create.dueAt).toBeNull();
    expect(arg.create.overdueAlertedAt ?? null).toBeNull();
  });

  it("UPDATES without touching dueAt when no days are given — a re-save is not a decision about the deadline", async () => {
    // The bug this encodes: the item page's days input renders blank, so
    // re-saving an already-flagged item to fix its note used to write
    // dueAt = null and silently wipe the deadline. The column must simply be
    // absent from the update.
    await upsertServiceRequest({ itemId: "i1", serviceType: "REPAIR", transferId: "t1" });
    const arg = vi.mocked(prisma.serviceQueueItem.upsert).mock.calls[0][0];
    expect("dueAt" in arg.update).toBe(false);
    // Same rule for the alert stamp: an unchanged deadline that already alerted
    // must not re-alert because someone edited the note.
    expect("overdueAlertedAt" in arg.update).toBe(false);
  });

  it("creates with dueAt = null, and updates nothing, for an explicitly null/undefined days value", async () => {
    await upsertServiceRequest({ itemId: "i1", serviceType: "REPAIR", overrideDays: null });
    await upsertServiceRequest({ itemId: "i2", serviceType: "REPAIR", overrideDays: undefined });
    const calls = vi.mocked(prisma.serviceQueueItem.upsert).mock.calls;
    expect(calls[0][0].create.dueAt).toBeNull();
    expect(calls[1][0].create.dueAt).toBeNull();
    expect("dueAt" in calls[0][0].update).toBe(false);
    expect("dueAt" in calls[1][0].update).toBe(false);
  });

  it("applies an explicit days value on BOTH branches", async () => {
    const before = Date.now();
    await upsertServiceRequest({ itemId: "i1", serviceType: "REPAIR", overrideDays: 3 });
    const arg = vi.mocked(prisma.serviceQueueItem.upsert).mock.calls[0][0];
    for (const dueAt of [arg.create.dueAt as Date, arg.update.dueAt as Date]) {
      expect(Math.round((dueAt.getTime() - before) / (24 * 60 * 60 * 1000))).toBe(3);
    }
    // Writing a NEW deadline does re-arm the alert — it is a different deadline.
    expect(arg.update.overdueAlertedAt).toBeNull();
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

// THE ACCEPTANCE TEST for the "re-saving wipes the deadline" bug. It drives the
// real service against a tiny in-memory row that applies the upsert exactly as
// Postgres would — absent keys leave the column alone, present keys overwrite it
// — so it measures the STORED value across saves rather than one call's argument
// shape. A representation that merely looks stable (days-remaining prefilled
// back into a days-from-now field) fails here on the second save.
describe("deadline round-trip: a no-op re-save must not move dueAt", () => {
  type Row = { id: string; itemId: string; dueAt: Date | null; overdueAlertedAt: Date | null; serviceNote: string | null };
  let row: Row;

  beforeEach(() => {
    row = { id: "sq1", itemId: "i1", dueAt: null, overdueAlertedAt: null, serviceNote: null };
    // Cast: Prisma's upsert arg type is far wider than this fake needs, and the
    // point of the fake is precisely that it applies ONLY the keys present in
    // `update`.
    const applyUpsert = async (args: { update: Partial<Row> }) => {
      // The row already exists for these cases, so the UPDATE branch applies —
      // and only the keys it actually carries.
      Object.assign(row, args.update);
      return row;
    };
    vi.mocked(prisma.serviceQueueItem.upsert).mockImplementation(
      applyUpsert as unknown as typeof prisma.serviceQueueItem.upsert,
    );
  });

  it("leaves the stored instant byte-identical across repeated saves", async () => {
    // Establish a deadline the way an operator would: flag it with 7 days.
    await upsertServiceRequest({ itemId: "i1", serviceType: "REPAIR", overrideDays: 7 });
    const established = row.dueAt!;
    expect(established).toBeInstanceOf(Date);

    // Now re-save five times for entirely unrelated reasons — switching the
    // service type, editing the note — with the deadline field left blank, as
    // the item page renders it.
    for (let i = 0; i < 5; i++) {
      await upsertServiceRequest({ itemId: "i1", serviceType: "OTHER", note: `pass ${i}` });
      expect(row.dueAt!.getTime()).toBe(established.getTime()); // exact instant, not "about a week"
    }
    expect(row.dueAt).toBe(established); // same object: never rewritten at all
    expect(row.serviceNote).toBe("pass 4"); // the edit that WAS asked for did land
  });

  it("does not extend the deadline even when time passes between saves", async () => {
    // The naive "prefill days remaining" fix passes the loop above only if no
    // clock moves; it fails the moment `now` advances, because N days remaining
    // re-saved means N days from the NEW now. Not writing the column is immune.
    await upsertServiceRequest({ itemId: "i1", serviceType: "REPAIR", overrideDays: 7 });
    const established = row.dueAt!.getTime();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)); // three days later
      await upsertServiceRequest({ itemId: "i1", serviceType: "REPAIR" });
    } finally {
      vi.useRealTimers();
    }
    expect(row.dueAt!.getTime()).toBe(established);
  });

  it("still re-arms the overdue alert only when a NEW deadline is written", async () => {
    row.dueAt = new Date("2026-01-01T00:00:00.000Z");
    row.overdueAlertedAt = new Date("2026-01-02T00:00:00.000Z");
    await upsertServiceRequest({ itemId: "i1", serviceType: "REPAIR" }); // blank days
    expect(row.overdueAlertedAt).not.toBeNull(); // no duplicate overdue email

    await upsertServiceRequest({ itemId: "i1", serviceType: "REPAIR", overrideDays: 5 });
    expect(row.overdueAlertedAt).toBeNull(); // a different deadline may alert again
  });
});

// The ONE write that may remove a deadline — deliberately its own operation, so
// that no ordinary save can reach this behavior. Mirrors the receipt return timer
// (setReceiptDueAtAction), where blank likewise clears from a dedicated form.
describe("setServiceDeadline", () => {
  it("clears the deadline for a null day count", async () => {
    await setServiceDeadline("i1", null);
    const arg = vi.mocked(prisma.serviceQueueItem.updateMany).mock.calls[0][0];
    expect(arg.where).toEqual({ itemId: "i1" });
    expect(arg.data.dueAt).toBeNull();
    expect(arg.data.overdueAlertedAt).toBeNull();
  });

  it("sets now + days for an explicit day count", async () => {
    const before = Date.now();
    await setServiceDeadline("i1", 4);
    const arg = vi.mocked(prisma.serviceQueueItem.updateMany).mock.calls[0][0];
    expect(Math.round(((arg.data.dueAt as Date).getTime() - before) / (24 * 60 * 60 * 1000))).toBe(4);
  });

  it("throws NOT_FOUND when the item is not flagged — never creates a row", async () => {
    vi.mocked(prisma.serviceQueueItem.updateMany).mockResolvedValueOnce({ count: 0 });
    await expect(setServiceDeadline("nope", 4)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(prisma.serviceQueueItem.upsert).not.toHaveBeenCalled();
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
    vi.mocked(__tx.serviceQueueItem.findUnique).mockResolvedValueOnce({ id: "sq1", itemId: "i1", status: "PENDING" });
    vi.mocked(__tx.serviceQueueItem.update).mockResolvedValueOnce({ id: "sq1", status: "COMPLETED" });
    const r = await completeServiceItem("sq1");
    expect(__tx.serviceQueueItem.update).toHaveBeenCalledWith({ where: { id: "sq1" }, data: { status: "COMPLETED" } });
    expect(r.status).toBe("COMPLETED");
  });

  it("stamps the item's markedReadyAt in the SAME transaction", async () => {
    // Finishing service means the device is physically in hand. Readiness is
    // derived, so without this stamp the item would leave IN_REPAIR straight
    // back to whatever its stale MDM logon implies.
    vi.mocked(__tx.serviceQueueItem.findUnique).mockResolvedValueOnce({ id: "sq1", itemId: "i1", status: "PENDING" });
    vi.mocked(__tx.serviceQueueItem.update).mockResolvedValueOnce({ id: "sq1", status: "COMPLETED" });
    await completeServiceItem("sq1");
    const arg = vi.mocked(__tx.item.updateMany).mock.calls[0][0];
    // Scoped to ACTIVE: "on hand" is meaningless for retired kit, and
    // updateMany means a vanished item cannot roll back the completion.
    expect(arg.where).toEqual({ id: "i1", status: "ACTIVE" });
    expect(arg.data.markedReadyAt).toBeInstanceOf(Date);
  });

  it("throws INVALID_STATUS when already completed", async () => {
    vi.mocked(__tx.serviceQueueItem.findUnique).mockResolvedValueOnce({ id: "sq1", status: "COMPLETED" });
    await expect(completeServiceItem("sq1")).rejects.toBeInstanceOf(ServiceQueueError);
    expect(__tx.item.updateMany).not.toHaveBeenCalled();
  });

  it("throws NOT_FOUND when missing", async () => {
    vi.mocked(__tx.serviceQueueItem.findUnique).mockResolvedValueOnce(null);
    await expect(completeServiceItem("nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(__tx.item.updateMany).not.toHaveBeenCalled();
  });
});

describe("reopenServiceItem side effects", () => {
  it("does NOT touch markedReadyAt — reopening means service again, not on hand", async () => {
    vi.mocked(__tx.serviceQueueItem.findUnique).mockResolvedValueOnce({ id: "sq1", itemId: "i1", status: "COMPLETED", serviceType: "REPAIR" });
    vi.mocked(__tx.serviceQueueItem.update).mockResolvedValueOnce({ id: "sq1", status: "PENDING" });
    await reopenServiceItem("sq1");
    expect(__tx.item.updateMany).not.toHaveBeenCalled();
  });
});

describe("reopenServiceItem", () => {
  it("COMPLETED -> PENDING keeping the existing deadline when no days are given, but always clearing the alert", async () => {
    vi.mocked(__tx.serviceQueueItem.findUnique).mockResolvedValueOnce({ id: "sq1", status: "COMPLETED", serviceType: "REPAIR" });
    vi.mocked(__tx.serviceQueueItem.update).mockResolvedValueOnce({ id: "sq1", status: "PENDING" });
    const r = await reopenServiceItem("sq1");
    const arg = vi.mocked(__tx.serviceQueueItem.update).mock.calls[0][0];
    expect(arg.where).toEqual({ id: "sq1" });
    expect(arg.data.status).toBe("PENDING");
    // Blank days on reopen leaves the stored deadline alone — the reopen form's
    // input is blank by default, so blank must not be a decision to discard it.
    // (Removing it is the deadline control's job, deliberately.)
    expect("dueAt" in arg.data).toBe(false);
    // Cleared regardless: reopening is a new round of service, so the previous
    // round's alert must not suppress the next one.
    expect(arg.data.overdueAlertedAt).toBeNull();
    expect(r.status).toBe("PENDING");
  });

  it("honors an override days on reopen (custom new deadline)", async () => {
    const before = Date.now();
    vi.mocked(__tx.serviceQueueItem.findUnique).mockResolvedValueOnce({ id: "sq1", status: "COMPLETED", serviceType: "REPAIR" });
    vi.mocked(__tx.serviceQueueItem.update).mockResolvedValueOnce({ id: "sq1", status: "PENDING" });
    await reopenServiceItem("sq1", 1);
    const arg = vi.mocked(__tx.serviceQueueItem.update).mock.calls[0][0];
    const days = Math.round((arg.data.dueAt.getTime() - before) / (24 * 60 * 60 * 1000));
    expect(days).toBe(1);
  });

  it("throws INVALID_STATUS when the item is not completed", async () => {
    vi.mocked(__tx.serviceQueueItem.findUnique).mockResolvedValueOnce({ id: "sq1", status: "PENDING", serviceType: "REPAIR" });
    await expect(reopenServiceItem("sq1")).rejects.toMatchObject({ code: "INVALID_STATUS" });
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
