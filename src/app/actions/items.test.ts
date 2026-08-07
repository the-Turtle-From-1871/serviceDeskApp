import { describe, it, expect, vi, beforeEach } from "vitest";

const requireUser = vi.fn();
const requireAdmin = vi.fn();
const updateItemFields = vi.fn();
const createItem = vi.fn();
const getItemBySerial = vi.fn();
const deleteItem = vi.fn();
const learnCategories = vi.fn();
const revalidatePath = vi.fn();

// Note: items.schema is NOT mocked — the real Zod schemas run, so this proves the
// server actually strips admin-only fields from a USER's submission.
vi.mock("@/lib/authz", () => ({
  requireUser: () => requireUser(),
  requireAdmin: () => requireAdmin(),
}));
// Only updateItemFields is exercised here; the rest are declared because the
// admin actions module (imported below for the identity tests) names them.
vi.mock("@/modules/items/items.service", () => ({
  updateItemFields: (id: string, data: unknown, editor: unknown) => updateItemFields(id, data, editor),
  createItem: (data: unknown, createdById: string) => createItem(data, createdById),
  getItemBySerial: (serial: string) => getItemBySerial(serial),
  deleteItem: (id: string) => deleteItem(id),
  setItemStatus: vi.fn(),
  analyzeImport: vi.fn(),
  commitImport: vi.fn(),
  markItemsReady: vi.fn(),
  MAX_BULK_ITEMS: 500,
}));
// The admin actions module imports resolutionSchema as a VALUE, and the real
// units.service pulls in the Prisma client. Stand in the same shape.
vi.mock("@/modules/items/units.service", async () => {
  const { z } = await import("zod");
  return { resolutionSchema: z.object({ abbreviation: z.string(), fullName: z.string() }) };
});
// Only the DB-backed half is stubbed; normalizeCategoryName is the real pure
// implementation (categories.service re-exports it from items.schema).
vi.mock("@/modules/items/categories.service", async () => {
  const { normalizeCategoryName } = await import("@/modules/items/items.schema");
  return {
    normalizeCategoryName,
    learnCategories: (names: string[]) => learnCategories(names),
  };
});
vi.mock("@/modules/items/items.errors", () => ({
  ItemError: class ItemError extends Error {
    code: string;
    constructor(code: string) { super(code); this.code = code; }
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));

import { updateItemDetailsAction } from "./items";
// The admin edit page's separate identity form (make/model/serialNumber) has
// its own action; it lives in the admin actions module but shares every mock
// above, so it is covered here alongside the surface it is deliberately kept
// out of.
import { updateItemIdentityAction, createItemAction, deleteItemAction } from "@/app/admin/actions/items";
import { Prisma } from "@prisma/client";

const ADMIN = { id: "a1", role: "ADMIN" as const, name: "Admin" };
const USER = { id: "u1", role: "USER" as const, name: "User" };

function fd(entries: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

// The full ADMIN-editable field set posted by the item detail card.
const ADMIN_FIELDS = {
  deviceName: "Laptop-01",
  homeUnit: "A Co",
  deviceUIC: "WABC01",
  currentUserEmail: "jane@u.mil",
  currentPosition: "Supply",
  notes: "Screen scratched",
  deviceCategory: "Laptop",
  storageLocation: "Bldg 400 Cage 3",
};

beforeEach(() => {
  vi.clearAllMocks();
  updateItemFields.mockResolvedValue({});
  learnCategories.mockResolvedValue(1);
  createItem.mockResolvedValue({ id: "new-1", serialNumber: "ABC123" });
  getItemBySerial.mockResolvedValue(null);
  deleteItem.mockResolvedValue(undefined);
});

describe("updateItemDetailsAction — role-gated fields", () => {
  it("USER may change ONLY currentUserEmail + currentPosition; forged admin-only fields are stripped server-side", async () => {
    requireUser.mockResolvedValue(USER);
    const res = await updateItemDetailsAction(
      undefined,
      fd({
        id: "item-1",
        ...ADMIN_FIELDS,
        deviceName: "HACKED",
        homeUnit: "HACKED UNIT",
        deviceUIC: "HACKED UIC",
        notes: "HACKED NOTE",
        deviceCategory: "HACKED CATEGORY",
        storageLocation: "HACKED SLOC",
      }),
    );
    expect(res).toEqual({ ok: true });
    const [id, data] = updateItemFields.mock.calls[0];
    expect(id).toBe("item-1");
    expect(data).toEqual({ currentUserEmail: "jane@u.mil", currentPosition: "Supply" });
    for (const f of ["deviceName", "homeUnit", "deviceUIC", "notes", "deviceCategory", "storageLocation"]) {
      expect(data).not.toHaveProperty(f);
    }
    // A USER's category never reaches the managed vocabulary either.
    expect(learnCategories).not.toHaveBeenCalled();
  });

  it("ADMIN may change all eight editable fields", async () => {
    requireUser.mockResolvedValue(ADMIN);
    const res = await updateItemDetailsAction(undefined, fd({ id: "item-1", ...ADMIN_FIELDS }));
    expect(res).toEqual({ ok: true });
    const [, data] = updateItemFields.mock.calls[0];
    expect(data).toEqual(ADMIN_FIELDS);
  });

  it("ADMIN cannot rewrite item identity — make/model/serialNumber are stripped", async () => {
    requireUser.mockResolvedValue(ADMIN);
    await updateItemDetailsAction(
      undefined,
      fd({ id: "item-1", ...ADMIN_FIELDS, make: "Dell", model: "5420", serialNumber: "SN-HACK" }),
    );
    const [, data] = updateItemFields.mock.calls[0];
    expect(data).toEqual(ADMIN_FIELDS);
  });

  it("ADMIN blanks CLEAR the nullable fields instead of no-opping", async () => {
    requireUser.mockResolvedValue(ADMIN);
    await updateItemDetailsAction(
      undefined,
      fd({ id: "item-1", ...ADMIN_FIELDS, homeUnit: "", deviceUIC: "  ", notes: "", deviceCategory: "  ", currentUserEmail: "", currentPosition: "", storageLocation: "  " }),
    );
    const [, data] = updateItemFields.mock.calls[0];
    expect(data).toEqual({
      deviceName: "Laptop-01",
      homeUnit: "",
      deviceUIC: "",
      currentUserEmail: "",
      currentPosition: "",
      notes: "",
      deviceCategory: "",
      storageLocation: "",
    });
    expect(learnCategories).not.toHaveBeenCalled();
  });

  it("normalizes an ADMIN's category and teaches it to the managed vocabulary", async () => {
    requireUser.mockResolvedValue(ADMIN);
    await updateItemDetailsAction(undefined, fd({ id: "item-1", ...ADMIN_FIELDS, deviceCategory: "  Tough   Book " }));
    const [, data] = updateItemFields.mock.calls[0];
    expect(data.deviceCategory).toBe("Tough Book");
    expect(learnCategories).toHaveBeenCalledWith(["Tough Book"]);
  });

  it("rejects a blank device name from an ADMIN (NOT NULL column)", async () => {
    requireUser.mockResolvedValue(ADMIN);
    const res = await updateItemDetailsAction(undefined, fd({ id: "item-1", ...ADMIN_FIELDS, deviceName: "  " }));
    expect(res).toEqual({ error: "Device name is required" });
    expect(updateItemFields).not.toHaveBeenCalled();
  });

  it("rejects a missing item id before touching the DB", async () => {
    requireUser.mockResolvedValue(USER);
    const res = await updateItemDetailsAction(undefined, fd({ currentUserEmail: "jane@u.mil", currentPosition: "Supply" }));
    expect(res).toEqual({ error: "Missing item." });
    expect(updateItemFields).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// updateItemIdentityAction — the SEPARATE make/model/serialNumber form on
// /admin/items/[itemId]/edit. Admin-only, its own schema, and routed through the
// same updateItemFields so the correction is recorded in ItemEdit history.
// ---------------------------------------------------------------------------

const IDENTITY = { make: "Dell", model: "Latitude 5420", serialNumber: "ABC123" };

function p2002(): Error {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
    meta: { target: ["serialNumber"] },
  });
}

describe("updateItemIdentityAction", () => {
  beforeEach(() => {
    requireAdmin.mockResolvedValue(ADMIN);
  });

  it("calls requireAdmin BEFORE any write, and writes nothing when it rejects", async () => {
    requireAdmin.mockRejectedValue(new Error("FORBIDDEN"));
    await expect(
      updateItemIdentityAction(undefined, fd({ id: "item-1", ...IDENTITY })),
    ).rejects.toThrow("FORBIDDEN");
    expect(requireAdmin).toHaveBeenCalledTimes(1);
    // A non-admin gets nothing written — not a partial save, not a history row.
    expect(updateItemFields).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("sends all three identity fields through updateItemFields, with the editor from the SERVER session", async () => {
    const res = await updateItemIdentityAction(undefined, fd({ id: "item-1", ...IDENTITY }));
    expect(res).toEqual({ ok: true });
    const [id, data, editor] = updateItemFields.mock.calls[0];
    expect(id).toBe("item-1");
    expect(data).toEqual(IDENTITY);
    expect(editor).toEqual({ id: "a1", name: "Admin" });
  });

  it("edits ONLY identity — the eight editable fields are stripped from this submission", async () => {
    await updateItemIdentityAction(
      undefined,
      fd({ id: "item-1", ...IDENTITY, ...ADMIN_FIELDS }),
    );
    const [, data] = updateItemFields.mock.calls[0];
    expect(data).toEqual(IDENTITY);
    for (const f of Object.keys(ADMIN_FIELDS)) expect(data).not.toHaveProperty(f);
  });

  it("trims, and passes a case-only correction through unchanged", async () => {
    // serialNumber is citext, so "abc123" -> "ABC123" is not a new identity; it
    // must reach the DB as typed rather than being normalized or refused.
    await updateItemIdentityAction(
      undefined,
      fd({ id: "item-1", ...IDENTITY, serialNumber: "  abc123  " }),
    );
    const [, data] = updateItemFields.mock.calls[0];
    expect(data.serialNumber).toBe("abc123");
  });

  it.each(["make", "model", "serialNumber"])(
    "rejects a blank %s (it backs a NOT NULL column) before touching the DB",
    async (field) => {
      const res = await updateItemIdentityAction(
        undefined,
        fd({ id: "item-1", ...IDENTITY, [field]: "   " }),
      );
      expect(res).toHaveProperty("error");
      expect(updateItemFields).not.toHaveBeenCalled();
    },
  );

  it("rejects a missing item id before touching the DB", async () => {
    const res = await updateItemIdentityAction(undefined, fd(IDENTITY));
    expect(res).toEqual({ error: "Missing item." });
    expect(updateItemFields).not.toHaveBeenCalled();
  });

  it("names the conflicting serial on a P2002 instead of the generic message", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    updateItemFields.mockRejectedValue(p2002());
    const res = await updateItemIdentityAction(undefined, fd({ id: "item-1", ...IDENTITY }));
    expect(res).toHaveProperty("error");
    const error = (res as { error: string }).error;
    expect(error).toContain("ABC123");
    expect(error).not.toContain("Something went wrong");
    // The Prisma detail is logged server-side, never returned (CLAUDE.md §5).
    expect(spy).toHaveBeenCalled();
    expect(error).not.toContain("Unique constraint failed");
    // No history row: ItemEdit is written inside the SAME transaction as the
    // update, so the constraint violation rolls both back — and the action
    // never reports a save.
    expect(res).not.toHaveProperty("ok");
    expect(revalidatePath).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("returns a generic message and logs server-side on an unexpected failure", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    updateItemFields.mockRejectedValue(new Error("boom"));
    const res = await updateItemIdentityAction(undefined, fd({ id: "item-1", ...IDENTITY }));
    expect(res).toEqual({ error: "Something went wrong saving your changes. Please try again." });
    expect(spy).toHaveBeenCalled();
    expect(JSON.stringify(res)).not.toContain("boom");
    spy.mockRestore();
  });

  it("revalidates the item list and the item page", async () => {
    await updateItemIdentityAction(undefined, fd({ id: "item-1", ...IDENTITY }));
    expect(revalidatePath).toHaveBeenCalledWith("/items");
    expect(revalidatePath).toHaveBeenCalledWith("/i/item-1");
  });
});

describe("createItemAction", () => {
  const NEW_ITEM = {
    make: "Dell", model: "5540", serialNumber: "ABC123",
    deviceName: "LT-01", homeUnit: "A Co", deviceUIC: "WABC01",
    deviceCategory: "  Docking   Station ", notes: "",
  };

  it("calls requireAdmin BEFORE any write, and writes nothing when it rejects", async () => {
    requireAdmin.mockRejectedValue(new Error("FORBIDDEN"));
    await expect(createItemAction(undefined, fd(NEW_ITEM))).rejects.toThrow("FORBIDDEN");
    expect(createItem).not.toHaveBeenCalled();
  });

  it("persists deviceUIC and the NORMALIZED category, with the creator from the SERVER session", async () => {
    requireAdmin.mockResolvedValue(ADMIN);
    await createItemAction(undefined, fd(NEW_ITEM));
    expect(createItem).toHaveBeenCalledWith(
      expect.objectContaining({ deviceUIC: "WABC01", deviceCategory: "Docking Station" }),
      ADMIN.id,
    );
  });

  it("teaches a typed category to the managed vocabulary", async () => {
    requireAdmin.mockResolvedValue(ADMIN);
    await createItemAction(undefined, fd(NEW_ITEM));
    expect(learnCategories).toHaveBeenCalledWith(["Docking Station"]);
  });

  it("does not call learnCategories when no category was typed", async () => {
    requireAdmin.mockResolvedValue(ADMIN);
    await createItemAction(undefined, fd({ ...NEW_ITEM, deviceCategory: "" }));
    expect(learnCategories).not.toHaveBeenCalled();
  });

  // The item is already committed by the time learnCategories runs. Reporting
  // its failure would tell the admin their item was not created when it was.
  it("still reports success when learnCategories fails", async () => {
    requireAdmin.mockResolvedValue(ADMIN);
    learnCategories.mockRejectedValue(new Error("vocabulary down"));
    await expect(createItemAction(undefined, fd(NEW_ITEM))).resolves.toEqual({ itemId: "new-1" });
  });

  it("names the conflicting serial on a P2002 and links to the item holding it", async () => {
    requireAdmin.mockResolvedValue(ADMIN);
    createItem.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "7" }),
    );
    getItemBySerial.mockResolvedValue({ id: "existing-9" });
    const res = await createItemAction(undefined, fd(NEW_ITEM));
    expect(res.error).toContain("ABC123");
    expect(res.existingItemId).toBe("existing-9");
  });

  it("still returns the collision error when the colliding item cannot be resolved", async () => {
    requireAdmin.mockResolvedValue(ADMIN);
    createItem.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "7" }),
    );
    getItemBySerial.mockResolvedValue(null);
    const res = await createItemAction(undefined, fd(NEW_ITEM));
    expect(res.error).toContain("ABC123");
    expect(res.existingItemId).toBeUndefined();
  });

  it("returns a generic message and logs server-side on an unexpected failure", async () => {
    requireAdmin.mockResolvedValue(ADMIN);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    createItem.mockRejectedValue(new Error("connection reset"));
    const res = await createItemAction(undefined, fd(NEW_ITEM));
    expect(res).toEqual({ error: "Something went wrong creating this item. Please try again." });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("revalidates the item list, the category admin page and analytics", async () => {
    requireAdmin.mockResolvedValue(ADMIN);
    await createItemAction(undefined, fd(NEW_ITEM));
    expect(revalidatePath).toHaveBeenCalledWith("/items");
    expect(revalidatePath).toHaveBeenCalledWith("/admin/categories");
    expect(revalidatePath).toHaveBeenCalledWith("/admin/analytics");
  });

  it("rejects a blank make before touching the DB", async () => {
    requireAdmin.mockResolvedValue(ADMIN);
    const res = await createItemAction(undefined, fd({ ...NEW_ITEM, make: "" }));
    expect(res.error).toMatch(/Make is required/);
    expect(createItem).not.toHaveBeenCalled();
  });

  it("returns to the filtered list when the form came from a search", async () => {
    requireAdmin.mockResolvedValue(ADMIN);
    createItem.mockResolvedValue({ id: "new-1", serialNumber: "ABC123" });
    const result = await createItemAction(undefined, fd({ ...NEW_ITEM, fromSearch: "1", returnUic: "" }));
    expect(result.itemId).toBe("new-1");
    expect(result.searchHref).toBe("/items?q=ABC123");
  });

  it("carries the unit filter back with it when the new item matches it", async () => {
    requireAdmin.mockResolvedValue(ADMIN);
    createItem.mockResolvedValue({ id: "new-1", serialNumber: "ABC123", deviceUIC: "WABC01" });
    const result = await createItemAction(undefined, fd({ ...NEW_ITEM, fromSearch: "1", returnUic: "WABC01" }));
    expect(result.itemId).toBe("new-1");
    expect(result.searchHref).toBe("/items?q=ABC123&uic=WABC01");
  });

  // Concatenation would produce ?q=A&B C — a different search, matching nothing.
  it("percent-encodes a serial containing URL metacharacters", async () => {
    requireAdmin.mockResolvedValue(ADMIN);
    createItem.mockResolvedValue({ id: "new-1", serialNumber: "A&B C#1" });
    const result = await createItemAction(undefined, fd({ ...NEW_ITEM, fromSearch: "1" }));
    expect(result.itemId).toBe("new-1");
    expect(result.searchHref).toBe("/items?q=A%26B+C%231");
  });

  it("does NOT redirect when the form was opened directly", async () => {
    requireAdmin.mockResolvedValue(ADMIN);
    const result = await createItemAction(undefined, fd(NEW_ITEM));
    expect(result.itemId).toBe("new-1");
    expect(result.searchHref).toBeUndefined();
  });

  // A collision returns early in the try/catch and is surfaced as an error,
  // while the success paths (which assert searchHref is set) prove that the
  // link is only built when the item is successfully created.
  it("does NOT redirect when the serial collided", async () => {
    requireAdmin.mockResolvedValue(ADMIN);
    createItem.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "7" }),
    );
    getItemBySerial.mockResolvedValue({ id: "existing-9" });
    const res = await createItemAction(undefined, fd({ ...NEW_ITEM, fromSearch: "1" }));
    expect(res.error).toContain("ABC123");
  });

  it("drops the unit filter from the redirect when the new item's deviceUIC is null", async () => {
    requireAdmin.mockResolvedValue(ADMIN);
    createItem.mockResolvedValue({ id: "new-1", serialNumber: "ABC123", deviceUIC: null });
    const result = await createItemAction(undefined, fd({ ...NEW_ITEM, fromSearch: "1", returnUic: "WABC01" }));
    expect(result.itemId).toBe("new-1");
    expect(result.searchHref).toBe("/items?q=ABC123");
  });

  it("drops the unit filter from the redirect when the new item's deviceUIC differs from it", async () => {
    requireAdmin.mockResolvedValue(ADMIN);
    createItem.mockResolvedValue({ id: "new-1", serialNumber: "ABC123", deviceUIC: "WXYZ02" });
    const result = await createItemAction(undefined, fd({ ...NEW_ITEM, fromSearch: "1", returnUic: "WABC01" }));
    expect(result.itemId).toBe("new-1");
    expect(result.searchHref).toBe("/items?q=ABC123");
  });
});

// ---------------------------------------------------------------------------
// deleteItemAction — permanent delete. deleteItem() itself enforces NO
// permissions (see its docstring in items.service.ts), so requireAdmin() here
// is the ENTIRE authorization boundary. The point of these tests is not just
// that a rejection throws (that would be true even if the guard ran after the
// delete) but that the destructive call never happens when it rejects.
// ---------------------------------------------------------------------------

describe("deleteItemAction", () => {
  it("calls requireAdmin BEFORE any write, and never calls deleteItem when it rejects", async () => {
    requireAdmin.mockRejectedValue(new Error("FORBIDDEN"));
    await expect(deleteItemAction(fd({ id: "item-1" }))).rejects.toThrow("FORBIDDEN");
    expect(requireAdmin).toHaveBeenCalledTimes(1);
    expect(deleteItem).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("deletes the item by id when requireAdmin resolves", async () => {
    requireAdmin.mockResolvedValue(ADMIN);
    const res = await deleteItemAction(fd({ id: "item-1" }));
    expect(res).toBeUndefined();
    expect(deleteItem).toHaveBeenCalledTimes(1);
    expect(deleteItem).toHaveBeenCalledWith("item-1");
    expect(revalidatePath).toHaveBeenCalledWith("/items");
    expect(revalidatePath).toHaveBeenCalledWith("/admin/analytics");
  });
});
