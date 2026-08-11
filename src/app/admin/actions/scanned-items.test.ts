import { describe, it, expect, vi, beforeEach } from "vitest";

const requireCapability = vi.fn();
vi.mock("@/lib/authz", async () => {
  const actual = await vi.importActual<typeof import("@/lib/authz")>("@/lib/authz");
  return { ...actual, requireCapability: (c: string) => requireCapability(c) };
});
const createScannedItems = vi.fn();
vi.mock("@/modules/items/items.service", () => ({ createScannedItems: (r: unknown, id: string) => createScannedItems(r, id) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { AuthError } from "@/lib/authz";
import { createScannedItemsAction } from "./scanned-items";

beforeEach(() => {
  vi.clearAllMocks();
  requireCapability.mockResolvedValue({ id: "admin1", name: "A", role: "ADMIN" });
  createScannedItems.mockResolvedValue({ items: [{ id: "i1", make: "HP", model: "G5", serialNumber: "AAA1", status: "ACTIVE" }], created: 1, existed: 0 });
});

const rows = [{ make: "HP", model: "G5", serialNumber: "AAA1" }];

describe("createScannedItemsAction", () => {
  it("gates on MANAGE_ITEMS, not on a role", async () => {
    await createScannedItemsAction(rows);
    expect(requireCapability).toHaveBeenCalledWith("MANAGE_ITEMS");
  });

  it("refuses a caller without the capability", async () => {
    requireCapability.mockRejectedValue(new AuthError("FORBIDDEN"));
    expect(await createScannedItemsAction(rows)).toEqual({ error: "You do not have permission to create items." });
    expect(createScannedItems).not.toHaveBeenCalled();
  });

  it("rejects a row that fails validation, without writing anything", async () => {
    expect(await createScannedItemsAction([{ make: "", model: "G5", serialNumber: "AAA1" }])).toMatchObject({ error: expect.any(String) });
    expect(createScannedItems).not.toHaveBeenCalled();
  });

  it("returns the created items for the caller's selection", async () => {
    expect(await createScannedItemsAction(rows)).toMatchObject({ ok: true, created: 1, existed: 0 });
  });
});
