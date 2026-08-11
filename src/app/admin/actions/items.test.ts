import { describe, it, expect, vi, beforeEach } from "vitest";

const requireCapability = vi.fn();
const previewRename = vi.fn();
const renameItems = vi.fn();
const revalidatePath = vi.fn();

// `class AuthError` is declared inside `vi.hoisted` (not as a plain top-level
// `class`) because `vi.mock` factories are hoisted above every other
// top-level statement in the file, including class declarations, which stay
// in the temporal dead zone until their own line runs. Referencing a
// not-yet-initialized `AuthError` directly (rather than behind a function,
// like `requireCapability` above) throws "Cannot access 'AuthError' before
// initialization" unless it is hoisted right along with `vi.mock` itself.
const { AuthError } = vi.hoisted(() => {
  class AuthError extends Error {
    constructor(public code: string) {
      super(code);
      this.name = "AuthError";
    }
  }
  return { AuthError };
});

// items.schema is NOT mocked — the real Zod constraints run, so this proves the
// server refuses a forged target rather than merely hiding it in the UI.
vi.mock("@/lib/authz", () => ({ requireCapability: () => requireCapability(), AuthError }));
vi.mock("@/modules/items/items.service", () => ({
  MAX_BULK_ITEMS: 500,
  previewRename: (ids: string[], prefix: string, start: string) => previewRename(ids, prefix, start),
  renameItems: (ids: string[], prefix: string, start: string, editor: unknown) =>
    renameItems(ids, prefix, start, editor),
}));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));

import { previewItemRenameAction, renameItemsAction } from "./items";

const ADMIN = { id: "admin-1", role: "ADMIN" as const, name: "Admin", email: "a@x.mil" };

function rfd(entries: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireCapability.mockResolvedValue(ADMIN);
  previewRename.mockResolvedValue({ count: 2, first: "X-1", last: "X-2", skipped: 0, collisions: [] });
  renameItems.mockResolvedValue({ ok: true, renamed: 2, unchanged: 0, skipped: 0 });
});

describe("renameItemsAction", () => {
  it("refuses a caller without MANAGE_ITEMS", async () => {
    requireCapability.mockRejectedValueOnce(new AuthError("FORBIDDEN"));
    await expect(
      renameItemsAction(rfd({ itemIds: "a1,a2", prefix: "LAPTOP", start: "001" })),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(renameItems).not.toHaveBeenCalled();
  });

  it("IGNORES a client-supplied name list and recomputes from prefix+start", async () => {
    const f = rfd({ itemIds: "a1,a2", prefix: "LAPTOP", start: "001" });
    f.append("names", "PWNED-1");
    f.append("names", "PWNED-2");
    await renameItemsAction(f);
    // The service is called with prefix+start, never with names.
    expect(renameItems).toHaveBeenCalledWith(["a1", "a2"], "LAPTOP", "001", expect.anything());
  });

  it("preserves the posted id ORDER, because order is the numbering", async () => {
    await renameItemsAction(rfd({ itemIds: "c3,a1,b2", prefix: "X", start: "1" }));
    expect(renameItems).toHaveBeenCalledWith(["c3", "a1", "b2"], "X", "1", expect.anything());
  });

  it("rejects a blank prefix and a non-digit start", async () => {
    expect(await renameItemsAction(rfd({ itemIds: "a1", prefix: " ", start: "001" }))).toHaveProperty("error");
    expect(await renameItemsAction(rfd({ itemIds: "a1", prefix: "X", start: "1a" }))).toHaveProperty("error");
  });

  it("reports a collision as a conflict rather than an error string", async () => {
    renameItems.mockResolvedValueOnce({ ok: false, collisions: [{ name: "X-1", serialNumber: "S1" }] });
    const res = await renameItemsAction(rfd({ itemIds: "a1", prefix: "X", start: "1" }));
    expect(res).toEqual({ conflict: true, collisions: [{ name: "X-1", serialNumber: "S1" }] });
  });
});

describe("previewItemRenameAction", () => {
  it("refuses a caller without MANAGE_ITEMS", async () => {
    requireCapability.mockRejectedValueOnce(new AuthError("FORBIDDEN"));
    await expect(
      previewItemRenameAction(rfd({ itemIds: "a1", prefix: "X", start: "1" })),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
