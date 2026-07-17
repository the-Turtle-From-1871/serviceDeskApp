import { describe, it, expect, vi, beforeEach } from "vitest";

const requireAdmin = vi.fn();
const upsertServiceRequest = vi.fn();
const reopenServiceItem = vi.fn();
const getCurrentOpenTransferId = vi.fn();
const revalidatePath = vi.fn();

vi.mock("@/lib/authz", () => ({ requireAdmin: () => requireAdmin() }));
vi.mock("@/modules/service-queue/service-queue.service", () => ({
  upsertServiceRequest: (i: unknown) => upsertServiceRequest(i),
  clearServiceRequest: vi.fn(),
  completeServiceItem: vi.fn(),
  reopenServiceItem: (id: string, days?: unknown) => reopenServiceItem(id, days),
}));
vi.mock("@/modules/transfers/transfers.service", () => ({
  getCurrentOpenTransferId: (itemId: string) => getCurrentOpenTransferId(itemId),
}));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));

import { setServiceAction, reopenServiceAction } from "./queue";

const ADMIN = { id: "admin-1", role: "ADMIN" as const, name: "Admin", email: "a@x.mil" };

function fd(entries: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAdmin.mockResolvedValue(ADMIN);
  getCurrentOpenTransferId.mockResolvedValue(null);
  upsertServiceRequest.mockResolvedValue({ id: "sq1" });
  reopenServiceItem.mockResolvedValue({ id: "sq1", status: "PENDING" });
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

  it("succeeds (no error) with an out-of-range override, falling back to the default", async () => {
    const res = await setServiceAction(
      undefined,
      fd({ itemId: "i1", serviceType: "REPAIR", overrideDays: "5000" }),
    );
    expect(res).toEqual({ ok: true });
    expect(upsertServiceRequest.mock.calls[0][0].overrideDays).toBeUndefined();
  });
});

describe("reopenServiceAction overrideDays coercion", () => {
  it("reopens with a blank overrideDays, threading undefined (type-default clock)", async () => {
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
      expect(reopenServiceItem.mock.calls[0][1]).toBeUndefined(); // with the type-default clock
    }
  });
});
