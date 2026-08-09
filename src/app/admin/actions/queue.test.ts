import { describe, it, expect, vi, beforeEach } from "vitest";

const requireCapability = vi.fn();
const upsertServiceRequest = vi.fn();
const reopenServiceItem = vi.fn();
const setServiceDeadline = vi.fn();
const getCurrentOpenTransferId = vi.fn();
const revalidatePath = vi.fn();

vi.mock("@/lib/authz", () => ({ requireCapability: () => requireCapability() }));
vi.mock("@/modules/service-queue/service-queue.service", () => ({
  upsertServiceRequest: (i: unknown) => upsertServiceRequest(i),
  clearServiceRequest: vi.fn(),
  completeServiceItem: vi.fn(),
  reopenServiceItem: (id: string, days?: unknown) => reopenServiceItem(id, days),
  setServiceDeadline: (itemId: string, days: number | null) => setServiceDeadline(itemId, days),
}));
vi.mock("@/modules/transfers/transfers.service", () => ({
  getCurrentOpenTransferId: (itemId: string) => getCurrentOpenTransferId(itemId),
}));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));

import { setServiceAction, reopenServiceAction, setServiceDeadlineAction } from "./queue";
import { ServiceQueueError } from "@/modules/service-queue/service-queue.errors";

const ADMIN = { id: "admin-1", role: "ADMIN" as const, name: "Admin", email: "a@x.mil" };

function fd(entries: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireCapability.mockResolvedValue(ADMIN);
  getCurrentOpenTransferId.mockResolvedValue(null);
  upsertServiceRequest.mockResolvedValue({ id: "sq1" });
  reopenServiceItem.mockResolvedValue({ id: "sq1", status: "PENDING" });
  setServiceDeadline.mockResolvedValue(undefined);
});

describe("setServiceAction overrideDays coercion", () => {
  it("succeeds with a blank overrideDays and threads it through as undefined", async () => {
    const res = await setServiceAction(
      undefined,
      fd({ itemId: "i1", serviceType: "REPAIR", overrideDays: "" }),
    );
    expect(res).toEqual({ ok: true });
    expect(upsertServiceRequest).toHaveBeenCalledTimes(1);
    expect(upsertServiceRequest.mock.calls[0][0].overrideDays).toBeUndefined();
  });

  it("succeeds with overrideDays entirely absent, threading it through as undefined", async () => {
    const res = await setServiceAction(undefined, fd({ itemId: "i1", serviceType: "REPAIR" }));
    expect(res).toEqual({ ok: true });
    expect(upsertServiceRequest).toHaveBeenCalledTimes(1);
    expect(upsertServiceRequest.mock.calls[0][0].overrideDays).toBeUndefined();
  });

  it("threads a numeric overrideDays through as a number", async () => {
    const res = await setServiceAction(
      undefined,
      fd({ itemId: "i1", serviceType: "REPAIR", overrideDays: "5" }),
    );
    expect(res).toEqual({ ok: true });
    expect(upsertServiceRequest).toHaveBeenCalledTimes(1);
    expect(upsertServiceRequest.mock.calls[0][0].overrideDays).toBe(5);
  });

  it("succeeds (no error) with an out-of-range override, yielding no deadline", async () => {
    const res = await setServiceAction(
      undefined,
      fd({ itemId: "i1", serviceType: "REPAIR", overrideDays: "5000" }),
    );
    expect(res).toEqual({ ok: true });
    expect(upsertServiceRequest.mock.calls[0][0].overrideDays).toBeUndefined();
  });
});

// The dedicated deadline control — the ONE place a blank field clears an
// existing deadline, and therefore the one place a malformed value must be
// rejected rather than gracefully collapsed to blank.
describe("setServiceDeadlineAction", () => {
  it("clears the deadline on a blank field (blank still means no deadline, deliberately)", async () => {
    const res = await setServiceDeadlineAction(undefined, fd({ itemId: "i1", overrideDays: "" }));
    expect(res).toEqual({ ok: true });
    expect(setServiceDeadline).toHaveBeenCalledWith("i1", null);
  });

  it("clears the deadline when the field is absent entirely", async () => {
    const res = await setServiceDeadlineAction(undefined, fd({ itemId: "i1" }));
    expect(res).toEqual({ ok: true });
    expect(setServiceDeadline).toHaveBeenCalledWith("i1", null);
  });

  it("sets an explicit day count", async () => {
    const res = await setServiceDeadlineAction(undefined, fd({ itemId: "i1", overrideDays: "9" }));
    expect(res).toEqual({ ok: true });
    expect(setServiceDeadline).toHaveBeenCalledWith("i1", 9);
  });

  it("REJECTS a malformed or out-of-range value instead of treating it as a clear", async () => {
    // parseOverrideDays' graceful collapse is right for the non-destructive
    // surfaces, but here it would turn a typo into a wiped deadline. Mirrors
    // setReceiptDueAtAction, which errors on the same inputs.
    for (const bad of ["0", "-5", "3651", "99999999", "12.9", "12abc"]) {
      setServiceDeadline.mockClear();
      const res = await setServiceDeadlineAction(undefined, fd({ itemId: "i1", overrideDays: bad }));
      expect(res.error).toBeTruthy();
      expect(setServiceDeadline).not.toHaveBeenCalled();
    }
  });

  it("reports a friendly error when the item is not flagged for service", async () => {
    setServiceDeadline.mockRejectedValueOnce(new ServiceQueueError("NOT_FOUND"));
    const res = await setServiceDeadlineAction(undefined, fd({ itemId: "i1", overrideDays: "3" }));
    expect(res.error).toBe("This item is not flagged for service.");
  });

  it("returns a generic message (not the stack) on an unexpected failure", async () => {
    setServiceDeadline.mockRejectedValueOnce(new Error("db exploded"));
    const res = await setServiceDeadlineAction(undefined, fd({ itemId: "i1", overrideDays: "3" }));
    expect(res.error).toBe("Something went wrong. Please try again.");
  });
});

describe("reopenServiceAction overrideDays coercion", () => {
  it("reopens with a blank overrideDays, threading undefined (keep the existing deadline)", async () => {
    await reopenServiceAction(fd({ id: "sq1", itemId: "i1", overrideDays: "" }));
    expect(reopenServiceItem).toHaveBeenCalledTimes(1);
    expect(reopenServiceItem.mock.calls[0][0]).toBe("sq1");
    expect(reopenServiceItem.mock.calls[0][1]).toBeUndefined();
  });

  it("reopens with an absent overrideDays, threading undefined", async () => {
    await reopenServiceAction(fd({ id: "sq1", itemId: "i1" }));
    expect(reopenServiceItem).toHaveBeenCalledTimes(1);
    expect(reopenServiceItem.mock.calls[0][1]).toBeUndefined();
  });

  it("threads a numeric override (custom new deadline) through as a number", async () => {
    await reopenServiceAction(fd({ id: "sq1", itemId: "i1", overrideDays: "10" }));
    expect(reopenServiceItem).toHaveBeenCalledTimes(1);
    expect(reopenServiceItem.mock.calls[0][1]).toBe(10);
  });

  it("still reopens (never silently no-ops) when the override is 0 or out of range", async () => {
    for (const bad of ["0", "99999999"]) {
      reopenServiceItem.mockClear();
      await reopenServiceAction(fd({ id: "sq1", itemId: "i1", overrideDays: bad }));
      expect(reopenServiceItem).toHaveBeenCalledTimes(1); // reopen proceeds
      expect(reopenServiceItem.mock.calls[0][1]).toBeUndefined(); // leaving the deadline as it stands
    }
  });
});
