import { describe, it, expect, vi, beforeEach } from "vitest";

const requireAdmin = vi.fn();
const upsertServiceRequest = vi.fn();
const getCurrentOpenTransferId = vi.fn();
const revalidatePath = vi.fn();

vi.mock("@/lib/authz", () => ({ requireAdmin: () => requireAdmin() }));
vi.mock("@/modules/service-queue/service-queue.service", () => ({
  upsertServiceRequest: (i: unknown) => upsertServiceRequest(i),
  clearServiceRequest: vi.fn(),
  completeServiceItem: vi.fn(),
  reopenServiceItem: vi.fn(),
}));
vi.mock("@/modules/transfers/transfers.service", () => ({
  getCurrentOpenTransferId: (itemId: string) => getCurrentOpenTransferId(itemId),
}));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));

import { setServiceAction } from "./queue";

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
});
