import { describe, it, expect, vi, beforeEach } from "vitest";

const requireCapability = vi.fn();
const markItemsReady = vi.fn();
const clearItemsReady = vi.fn();
const setItemsStatus = vi.fn();
const setItemsCategory = vi.fn();
const revalidatePath = vi.fn();

// items.schema is NOT mocked — the real Zod constraints run, so this proves the
// server refuses a forged target rather than merely hiding it in the UI.
vi.mock("@/lib/authz", () => ({ denyReadOnly: () => null, requireCapability: () => requireCapability() }));
vi.mock("@/modules/items/items.service", () => ({
  MAX_BULK_ITEMS: 500,
  markItemsReady: (ids: string[]) => markItemsReady(ids),
  clearItemsReady: (ids: string[]) => clearItemsReady(ids),
  setItemsStatus: (ids: string[], status: string) => setItemsStatus(ids, status),
  setItemsCategory: (ids: string[], cat: string, editor: unknown) =>
    setItemsCategory(ids, cat, editor),
}));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));

import { setReadinessAction, setItemsCategoryAction } from "./readiness";
// The real ItemError — items.errors is deliberately NOT mocked, so the action's
// `instanceof` branch is exercised for real.
import { ItemError } from "@/modules/items/items.errors";

const ADMIN = { id: "admin-1", role: "ADMIN" as const, name: "Admin", email: "a@x.mil" };

function fd(entries: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireCapability.mockResolvedValue(ADMIN);
  markItemsReady.mockResolvedValue({ updated: 2 });
  clearItemsReady.mockResolvedValue({ updated: 2 });
  setItemsStatus.mockResolvedValue({ updated: 2 });
  setItemsCategory.mockResolvedValue({ updated: 2, unchanged: 0 });
});

describe("setReadinessAction — admin gate", () => {
  it("calls requireCapability BEFORE any write, and writes nothing when it rejects", async () => {
    requireCapability.mockRejectedValue(new Error("FORBIDDEN"));
    await expect(
      setReadinessAction(fd({ itemIds: "i1", target: "READY_TO_DEPLOY" })),
    ).rejects.toThrow("FORBIDDEN");
    expect(requireCapability).toHaveBeenCalledTimes(1);
    expect(markItemsReady).not.toHaveBeenCalled();
    expect(clearItemsReady).not.toHaveBeenCalled();
    expect(setItemsStatus).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("setReadinessAction — target routes to the real underlying signal", () => {
  it("Ready to deploy goes through the SAME markItemsReady as 'Mark as on hand'", async () => {
    const res = await setReadinessAction(fd({ itemIds: "i1,i2", target: "READY_TO_DEPLOY" }));
    expect(res).toEqual({ ok: true, updated: 2, target: "READY_TO_DEPLOY" });
    expect(markItemsReady).toHaveBeenCalledWith(["i1", "i2"]);
    expect(setItemsStatus).not.toHaveBeenCalled();
  });

  it("Untriaged clears the stamp rather than storing a readiness value", async () => {
    const res = await setReadinessAction(fd({ itemIds: "i1,i2", target: "UNTRIAGED" }));
    expect(res).toEqual({ ok: true, updated: 2, target: "UNTRIAGED" });
    expect(clearItemsReady).toHaveBeenCalledWith(["i1", "i2"]);
    expect(markItemsReady).not.toHaveBeenCalled();
  });

  it("Retired sets the lifecycle column", async () => {
    await setReadinessAction(fd({ itemIds: "i1", target: "RETIRED" }));
    expect(setItemsStatus).toHaveBeenCalledWith(["i1"], "RETIRED");
  });

  it("Active un-retires through the same lifecycle column", async () => {
    await setReadinessAction(fd({ itemIds: "i1", target: "ACTIVE" }));
    expect(setItemsStatus).toHaveBeenCalledWith(["i1"], "ACTIVE");
  });

  it("revalidates /items and the analytics dashboard readiness feeds", async () => {
    await setReadinessAction(fd({ itemIds: "i1", target: "READY_TO_DEPLOY" }));
    expect(revalidatePath).toHaveBeenCalledWith("/items");
    expect(revalidatePath).toHaveBeenCalledWith("/admin/analytics");
  });
});

describe("setReadinessAction — derived states are refused server-side", () => {
  it.each(["DEPLOYED", "IN_REPAIR"])(
    "rejects a forged %s target instead of silently ignoring it",
    async (target) => {
      const res = await setReadinessAction(fd({ itemIds: "i1", target }));
      expect(res).toHaveProperty("error");
      expect(markItemsReady).not.toHaveBeenCalled();
      expect(clearItemsReady).not.toHaveBeenCalled();
      expect(setItemsStatus).not.toHaveBeenCalled();
    },
  );

  it("rejects an unknown target", async () => {
    const res = await setReadinessAction(fd({ itemIds: "i1", target: "NONSENSE" }));
    expect(res).toHaveProperty("error");
    expect(setItemsStatus).not.toHaveBeenCalled();
  });
});

describe("setReadinessAction — input bounds", () => {
  it("requires at least one item", async () => {
    const res = await setReadinessAction(fd({ itemIds: "", target: "RETIRED" }));
    expect(res).toEqual({ error: "Select at least one item." });
    expect(setItemsStatus).not.toHaveBeenCalled();
  });

  it("refuses more than MAX_BULK_ITEMS before touching the DB", async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `i${i}`).join(",");
    const res = await setReadinessAction(fd({ itemIds: ids, target: "RETIRED" }));
    expect(res).toEqual({ error: "Too many items selected. The limit is 500 per action." });
    expect(setItemsStatus).not.toHaveBeenCalled();
  });

  it("maps a service TOO_MANY into a readable message, not a stack trace", async () => {
    setItemsStatus.mockRejectedValue(new ItemError("TOO_MANY"));
    const res = await setReadinessAction(fd({ itemIds: "i1", target: "RETIRED" }));
    expect(res).toEqual({ error: "Too many items selected. The limit is 500 per action." });
  });

  it("returns a generic message and logs server-side on an unexpected failure", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    setItemsStatus.mockRejectedValue(new Error("boom"));
    const res = await setReadinessAction(fd({ itemIds: "i1", target: "RETIRED" }));
    expect(res).toEqual({ error: "Something went wrong updating those items. Please try again." });
    expect(spy).toHaveBeenCalled();
    // The detail never reaches the client.
    expect(JSON.stringify(res)).not.toContain("boom");
    spy.mockRestore();
  });
});

describe("setItemsCategoryAction", () => {
  it("calls requireCapability BEFORE any write, and writes nothing when it rejects", async () => {
    requireCapability.mockRejectedValue(new Error("FORBIDDEN"));
    await expect(
      setItemsCategoryAction(fd({ itemIds: "i1", category: "Laptops" })),
    ).rejects.toThrow("FORBIDDEN");
    expect(setItemsCategory).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("resolves the editor from the SERVER session, never from the client payload", async () => {
    await setItemsCategoryAction(
      fd({ itemIds: "i1,i2", category: "Laptops", editedByName: "SOMEONE ELSE" }),
    );
    expect(setItemsCategory).toHaveBeenCalledWith(["i1", "i2"], "Laptops", {
      id: "admin-1",
      name: "Admin",
    });
  });

  it("reports how many changed and how many already held the value", async () => {
    setItemsCategory.mockResolvedValue({ updated: 1, unchanged: 1 });
    const res = await setItemsCategoryAction(fd({ itemIds: "i1,i2", category: "Laptops" }));
    expect(res).toEqual({ ok: true, updated: 1, unchanged: 1, category: "Laptops" });
    expect(revalidatePath).toHaveBeenCalledWith("/items");
    expect(revalidatePath).toHaveBeenCalledWith("/admin/analytics");
  });

  it("requires a category", async () => {
    const res = await setItemsCategoryAction(fd({ itemIds: "i1", category: "   " }));
    expect(res).toEqual({ error: "Choose a category." });
    expect(setItemsCategory).not.toHaveBeenCalled();
  });

  it("requires at least one item", async () => {
    const res = await setItemsCategoryAction(fd({ itemIds: "", category: "Laptops" }));
    expect(res).toEqual({ error: "Select at least one item." });
    expect(setItemsCategory).not.toHaveBeenCalled();
  });

  it("rejects an over-long category name", async () => {
    const res = await setItemsCategoryAction(fd({ itemIds: "i1", category: "x".repeat(61) }));
    expect(res).toHaveProperty("error");
    expect(setItemsCategory).not.toHaveBeenCalled();
  });

  it("returns a generic message and logs server-side on an unexpected failure", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    setItemsCategory.mockRejectedValue(new Error("boom"));
    const res = await setItemsCategoryAction(fd({ itemIds: "i1", category: "Laptops" }));
    expect(res).toEqual({ error: "Something went wrong updating those items. Please try again." });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
