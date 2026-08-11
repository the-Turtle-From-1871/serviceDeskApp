import { describe, it, expect, vi, beforeEach } from "vitest";

const requireCapability = vi.fn();
vi.mock("@/lib/authz", async () => {
  const actual = await vi.importActual<typeof import("@/lib/authz")>("@/lib/authz");
  return { ...actual, requireCapability: (c: string) => requireCapability(c) };
});
const createScannedItems = vi.fn();
vi.mock("@/modules/items/items.service", () => ({ createScannedItems: (r: unknown, id: string) => createScannedItems(r, id) }));
const learnCategories = vi.fn();
vi.mock("@/modules/items/categories.service", () => ({ learnCategories: (names: string[]) => learnCategories(names) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { AuthError } from "@/lib/authz";
import { createScannedItemsAction } from "./scanned-items";

beforeEach(() => {
  vi.clearAllMocks();
  requireCapability.mockResolvedValue({ id: "admin1", name: "A", role: "ADMIN" });
  createScannedItems.mockResolvedValue({ items: [{ id: "i1", make: "HP", model: "G5", serialNumber: "AAA1", status: "ACTIVE" }], created: 1, existed: 0 });
  learnCategories.mockResolvedValue(1);
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

  // A category typed onto a scanned row is item vocabulary, just like every
  // other write site (createItemAction, updateItemAction, the CSV import) —
  // miss this and /admin/categories under-reports the in-use count and lets
  // an admin delete a category that is still assigned.
  it("learns the distinct, non-empty categories from the batch", async () => {
    const withCategories = [
      { make: "HP", model: "G5", serialNumber: "AAA1", deviceCategory: "Laptop" },
      { make: "HP", model: "G5", serialNumber: "AAA2", deviceCategory: "Laptop" },
      { make: "Dell", model: "X1", serialNumber: "AAA3", deviceCategory: "Tablet" },
      { make: "Dell", model: "X1", serialNumber: "AAA4" },
    ];
    await createScannedItemsAction(withCategories);
    expect(learnCategories).toHaveBeenCalledWith(["Laptop", "Tablet"]);
  });

  it("does not call learnCategories when no scanned row carries a category", async () => {
    await createScannedItemsAction(rows);
    expect(learnCategories).not.toHaveBeenCalled();
  });

  // The item batch is already committed by the time learnCategories runs —
  // this is a separate transaction, so its failure must not fail the action
  // or roll back reporting of the batch that already exists.
  it("still reports success when learnCategories fails", async () => {
    learnCategories.mockRejectedValue(new Error("vocabulary down"));
    const withCategory = [{ make: "HP", model: "G5", serialNumber: "AAA1", deviceCategory: "Laptop" }];
    const res = await createScannedItemsAction(withCategory);
    expect(res).toMatchObject({ ok: true });
  });
});
