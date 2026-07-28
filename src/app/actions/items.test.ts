import { describe, it, expect, vi, beforeEach } from "vitest";

const requireUser = vi.fn();
const requireAdmin = vi.fn();
const updateItemFields = vi.fn();
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
  createItem: vi.fn(),
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
import { updateItemIdentityAction } from "@/app/admin/actions/items";
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
};

beforeEach(() => {
  vi.clearAllMocks();
  updateItemFields.mockResolvedValue({});
  learnCategories.mockResolvedValue(1);
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
      }),
    );
    expect(res).toEqual({ ok: true });
    const [id, data] = updateItemFields.mock.calls[0];
    expect(id).toBe("item-1");
    expect(data).toEqual({ currentUserEmail: "jane@u.mil", currentPosition: "Supply" });
    for (const f of ["deviceName", "homeUnit", "deviceUIC", "notes", "deviceCategory"]) {
      expect(data).not.toHaveProperty(f);
    }
    // A USER's category never reaches the managed vocabulary either.
    expect(learnCategories).not.toHaveBeenCalled();
  });

  it("ADMIN may change all seven editable fields", async () => {
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
      fd({ id: "item-1", ...ADMIN_FIELDS, homeUnit: "", deviceUIC: "  ", notes: "", deviceCategory: "  ", currentUserEmail: "", currentPosition: "" }),
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

  it("edits ONLY identity — the seven editable fields are stripped from this submission", async () => {
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
