import { describe, it, expect, vi, beforeEach } from "vitest";

const requireUser = vi.fn();
const getItem = vi.fn();
const getLastReceiver = vi.fn();

vi.mock("@/lib/authz", () => ({
  requireUser: () => requireUser(),
  AuthError: class AuthError extends Error {},
}));
vi.mock("@/modules/items/items.service", () => ({
  getItem: (id: string) => getItem(id),
}));
vi.mock("@/modules/transfers/transfers.service", () => ({
  getLastReceiver: (id: string) => getLastReceiver(id),
}));

import { lookupScannedItem } from "./scan";
import { AuthError } from "@/lib/authz";

const ITEM = {
  id: "i1",
  make: "Dell",
  model: "L5420",
  serialNumber: "SN1",
  status: "ACTIVE",
  notes: "ADMIN ONLY — do not leak",
  homeUnit: "A Co",
};

beforeEach(() => {
  vi.clearAllMocks();
  requireUser.mockResolvedValue({ id: "u1", role: "USER", name: "Op" });
  getItem.mockResolvedValue(ITEM);
  getLastReceiver.mockResolvedValue(null);
});

describe("lookupScannedItem", () => {
  it("returns the item's display fields", async () => {
    const res = await lookupScannedItem("i1");
    expect(res).toEqual({
      ok: true,
      item: { id: "i1", make: "Dell", model: "L5420", serialNumber: "SN1" },
      holderName: null,
    });
  });

  // Client-component props are serialized into the RSC payload and reach the
  // browser regardless of what renders. i/[itemId]/page.tsx:59-65 gates notes
  // server-side for this exact reason; returning the whole Item here would
  // undo that for every scan.
  it("never returns admin-only fields", async () => {
    const res = await lookupScannedItem("i1");
    expect(JSON.stringify(res)).not.toContain("ADMIN ONLY");
    expect(res.ok && "notes" in res.item).toBe(false);
  });

  it("names the current holder when there is one", async () => {
    getLastReceiver.mockResolvedValue({ isDcsim: false, name: "CPL Jones" });
    const res = await lookupScannedItem("i1");
    expect(res).toMatchObject({ ok: true, holderName: "CPL Jones" });
  });

  it("refuses an unknown id", async () => {
    getItem.mockResolvedValue(null);
    expect(await lookupScannedItem("nope")).toEqual({ ok: false, code: "NOT_FOUND" });
  });

  // Mirrors receipts/new/page.tsx:17 — a scan must not be a backdoor around the
  // ACTIVE filter the builder already applies on load.
  it("refuses a retired item", async () => {
    getItem.mockResolvedValue({ ...ITEM, status: "RETIRED" });
    expect(await lookupScannedItem("i1")).toEqual({ ok: false, code: "RETIRED" });
  });

  it("checks auth before touching any data", async () => {
    requireUser.mockRejectedValue(new AuthError("UNAUTHORIZED"));
    expect(await lookupScannedItem("i1")).toEqual({ ok: false, code: "UNAUTHORIZED" });
    expect(getItem).not.toHaveBeenCalled();
  });

  it("returns FAILED and logs on an unexpected error", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    getItem.mockRejectedValue(new Error("db is on fire"));
    expect(await lookupScannedItem("i1")).toEqual({ ok: false, code: "FAILED" });
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("refuses blank input without a query", async () => {
    expect(await lookupScannedItem("  ")).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(getItem).not.toHaveBeenCalled();
  });
});
