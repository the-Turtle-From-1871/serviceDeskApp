import { describe, it, expect, vi, beforeEach } from "vitest";

const requireUser = vi.fn();
const updateItemFields = vi.fn();
const revalidatePath = vi.fn();

// Note: items.schema is NOT mocked — the real Zod schemas run, so this proves the
// server actually strips admin-only fields from a USER's submission.
vi.mock("@/lib/authz", () => ({ requireUser: () => requireUser() }));
vi.mock("@/modules/items/items.service", () => ({
  updateItemFields: (id: string, data: unknown, editor: unknown) => updateItemFields(id, data, editor),
}));
vi.mock("@/modules/items/items.errors", () => ({
  ItemError: class ItemError extends Error {
    code: string;
    constructor(code: string) { super(code); this.code = code; }
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));

import { updateItemDetailsAction } from "./items";

const ADMIN = { id: "a1", role: "ADMIN" as const, name: "Admin" };
const USER = { id: "u1", role: "USER" as const, name: "User" };

function fd(entries: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  updateItemFields.mockResolvedValue({});
});

describe("updateItemDetailsAction — role-gated fields", () => {
  it("USER may change ONLY currentUserEmail + currentPosition; a forged deviceName/homeUnit is stripped server-side", async () => {
    requireUser.mockResolvedValue(USER);
    const res = await updateItemDetailsAction(
      undefined,
      fd({ id: "item-1", deviceName: "HACKED", homeUnit: "HACKED UNIT", currentUserEmail: "jane@u.mil", currentPosition: "Supply" }),
    );
    expect(res).toEqual({ ok: true });
    const [id, data] = updateItemFields.mock.calls[0];
    expect(id).toBe("item-1");
    expect(data).toEqual({ currentUserEmail: "jane@u.mil", currentPosition: "Supply" });
    expect(data).not.toHaveProperty("deviceName");
    expect(data).not.toHaveProperty("homeUnit");
  });

  it("ADMIN may change every item detail field", async () => {
    requireUser.mockResolvedValue(ADMIN);
    const res = await updateItemDetailsAction(
      undefined,
      fd({ id: "item-1", deviceName: "Laptop-01", homeUnit: "A Co", currentUserEmail: "jane@u.mil", currentPosition: "Supply" }),
    );
    expect(res).toEqual({ ok: true });
    const [, data] = updateItemFields.mock.calls[0];
    expect(data).toEqual({ deviceName: "Laptop-01", homeUnit: "A Co", currentUserEmail: "jane@u.mil", currentPosition: "Supply" });
  });

  it("rejects a missing item id before touching the DB", async () => {
    requireUser.mockResolvedValue(USER);
    const res = await updateItemDetailsAction(undefined, fd({ currentUserEmail: "jane@u.mil", currentPosition: "Supply" }));
    expect(res).toEqual({ error: "Missing item." });
    expect(updateItemFields).not.toHaveBeenCalled();
  });
});
