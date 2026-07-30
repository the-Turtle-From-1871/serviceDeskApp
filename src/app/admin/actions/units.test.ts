import { describe, it, expect, vi, beforeEach } from "vitest";

const requireAdmin = vi.fn();
const learnUnits = vi.fn();
const renameUnit = vi.fn();
const deleteUnit = vi.fn();
const revalidatePath = vi.fn();

vi.mock("@/lib/authz", () => ({
  requireAdmin: () => requireAdmin(),
  AuthError: class extends Error {},
}));
// The real units.service pulls in the Prisma client (module-level
// `import prisma from "@/lib/prisma"`), so it is stubbed here — including a
// real resolutionSchema shape, since createUnitAction validates against it
// directly and units.parse.ts (imported transitively by the actions module)
// also reads it.
vi.mock("@/modules/items/units.service", async () => {
  const { z } = await import("zod");
  return {
    resolutionSchema: z.object({
      abbreviation: z
        .string()
        .trim()
        .min(1, "Abbreviation is required")
        .regex(/^[A-Za-z0-9]+$/, "Abbreviation must be letters and digits only"),
      fullName: z.string().trim().min(1, "Unit name is required"),
    }),
    learnUnits: (...args: unknown[]) => learnUnits(...args),
    renameUnit: (...args: unknown[]) => renameUnit(...args),
    deleteUnit: (...args: unknown[]) => deleteUnit(...args),
  };
});
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));

import {
  createUnitAction,
  renameUnitAction,
  deleteUnitAction,
  bulkLearnUnitsAction,
} from "./units";
import { ItemError } from "@/modules/items/items.errors";

const ADMIN = { id: "admin-1", role: "ADMIN" as const, name: "Admin", email: "a@b.mil" };

function fd(entries: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAdmin.mockResolvedValue(ADMIN);
});

describe("createUnitAction", () => {
  it("teaches a valid abbreviation + full name and revalidates the units page", async () => {
    learnUnits.mockResolvedValue({ created: 1, updated: 0 });
    const res = await createUnitAction(undefined, fd({ abbreviation: "wabc01", fullName: "HHC 1-8" }));
    expect(res).toEqual({ ok: true });
    expect(learnUnits).toHaveBeenCalledWith([{ abbreviation: "wabc01", fullName: "HHC 1-8" }]);
    expect(revalidatePath).toHaveBeenCalledWith("/admin/units");
  });

  it("rejects an abbreviation with characters the schema forbids, before touching the DB", async () => {
    const res = await createUnitAction(undefined, fd({ abbreviation: "W-ABC", fullName: "Some Unit" }));
    expect(res).toHaveProperty("error");
    expect(learnUnits).not.toHaveBeenCalled();
  });

  it("returns a generic message and logs server-side on an unexpected failure", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    learnUnits.mockRejectedValue(new Error("boom"));
    const res = await createUnitAction(undefined, fd({ abbreviation: "WABC01", fullName: "HHC 1-8" }));
    expect(res).toEqual({ error: "Something went wrong. Please try again." });
    expect(spy).toHaveBeenCalled();
    expect(JSON.stringify(res)).not.toContain("boom");
    spy.mockRestore();
  });

  it("calls requireAdmin before any write", async () => {
    requireAdmin.mockRejectedValue(new Error("FORBIDDEN"));
    await expect(createUnitAction(undefined, fd({ abbreviation: "WABC01", fullName: "HHC 1-8" }))).rejects.toThrow(
      "FORBIDDEN",
    );
    expect(learnUnits).not.toHaveBeenCalled();
  });
});

describe("renameUnitAction", () => {
  it("rejects a missing unit id before touching the DB", async () => {
    const res = await renameUnitAction(undefined, fd({ fullName: "New Name" }));
    expect(res).toEqual({ error: "Missing unit." });
    expect(renameUnit).not.toHaveBeenCalled();
  });

  it("rejects a blank name before touching the DB", async () => {
    const res = await renameUnitAction(undefined, fd({ id: "unit-1", fullName: "   " }));
    expect(res).toEqual({ error: "Enter a unit name." });
    expect(renameUnit).not.toHaveBeenCalled();
  });

  it("renames, reports itemsUpdated, and revalidates both /admin/units and /items", async () => {
    renameUnit.mockResolvedValue({ abbreviation: "WABC01", itemsUpdated: 3 });
    const res = await renameUnitAction(undefined, fd({ id: "unit-1", fullName: "New Name" }));
    expect(res).toEqual({ ok: true, itemsUpdated: 3 });
    expect(renameUnit).toHaveBeenCalledWith("unit-1", "New Name", { id: "admin-1", name: "Admin" });
    expect(revalidatePath).toHaveBeenCalledWith("/admin/units");
    expect(revalidatePath).toHaveBeenCalledWith("/items");
  });

  it("surfaces an ItemError message directly to the client", async () => {
    renameUnit.mockRejectedValue(new ItemError("NOT_FOUND", "That unit no longer exists."));
    const res = await renameUnitAction(undefined, fd({ id: "unit-1", fullName: "New Name" }));
    expect(res).toEqual({ error: "That unit no longer exists." });
  });

  it("returns a generic message and logs server-side on an unexpected failure", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    renameUnit.mockRejectedValue(new Error("boom"));
    const res = await renameUnitAction(undefined, fd({ id: "unit-1", fullName: "New Name" }));
    expect(res).toEqual({ error: "Something went wrong. Please try again." });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("calls requireAdmin before any write, and writes nothing when it rejects", async () => {
    requireAdmin.mockRejectedValue(new Error("FORBIDDEN"));
    await expect(
      renameUnitAction(undefined, fd({ id: "unit-1", fullName: "New Name" })),
    ).rejects.toThrow("FORBIDDEN");
    // Not just that the call threw — the underlying write must never have
    // happened. If a call site dropped requireAdmin() (or moved it after the
    // write), renameUnit would still have fired here.
    expect(renameUnit).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("deleteUnitAction", () => {
  it("rejects a missing unit id before touching the DB", async () => {
    const res = await deleteUnitAction(fd({}));
    expect(res).toEqual({ error: "Missing unit." });
    expect(deleteUnit).not.toHaveBeenCalled();
  });

  it("deletes and revalidates /admin/units", async () => {
    deleteUnit.mockResolvedValue({ abbreviation: "WABC01" });
    const res = await deleteUnitAction(fd({ id: "unit-1" }));
    expect(res).toEqual({ ok: true });
    expect(deleteUnit).toHaveBeenCalledWith("unit-1");
    expect(revalidatePath).toHaveBeenCalledWith("/admin/units");
  });

  it("surfaces an ItemError (e.g. IN_USE) message directly to the client", async () => {
    deleteUnit.mockRejectedValue(new ItemError("IN_USE", '"HHC 1-8" is still the home unit of 2 items.'));
    const res = await deleteUnitAction(fd({ id: "unit-1" }));
    expect(res).toEqual({ error: '"HHC 1-8" is still the home unit of 2 items.' });
  });

  it("calls requireAdmin before any write, and writes nothing when it rejects", async () => {
    requireAdmin.mockRejectedValue(new Error("FORBIDDEN"));
    await expect(deleteUnitAction(fd({ id: "unit-1" }))).rejects.toThrow("FORBIDDEN");
    // Not just that the call threw — the unit row must never have been
    // touched. If requireAdmin() were dropped (or moved after the write),
    // deleteUnit would still have fired here.
    expect(deleteUnit).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("bulkLearnUnitsAction", () => {
  it("reports a bad line instead of silently dropping it, and never reaches learnUnits", async () => {
    const res = await bulkLearnUnitsAction(undefined, fd({ block: "WABC01,HHC 1-8\nnonsense" }));
    expect(res).toHaveProperty("error");
    expect((res as { error: string }).error).toMatch(/line 2/i);
    expect(learnUnits).not.toHaveBeenCalled();
  });

  it("rejects an empty block", async () => {
    const res = await bulkLearnUnitsAction(undefined, fd({ block: "   \n  " }));
    expect(res).toEqual({ error: "Nothing to add." });
    expect(learnUnits).not.toHaveBeenCalled();
  });

  it("reports the REAL created/updated split from learnUnits, not the submitted line count", async () => {
    learnUnits.mockResolvedValue({ created: 1, updated: 1 });
    const res = await bulkLearnUnitsAction(
      undefined,
      fd({ block: "WABC01,HHC 1-8\nWDEF02,B CO 44" }),
    );
    expect(res).toEqual({ ok: true, created: 1, updated: 1 });
    expect(learnUnits).toHaveBeenCalledWith([
      { abbreviation: "WABC01", fullName: "HHC 1-8" },
      { abbreviation: "WDEF02", fullName: "B CO 44" },
    ]);
    expect(revalidatePath).toHaveBeenCalledWith("/admin/units");
  });

  it("returns a generic message and logs server-side on an unexpected failure", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    learnUnits.mockRejectedValue(new Error("boom"));
    const res = await bulkLearnUnitsAction(undefined, fd({ block: "WABC01,HHC 1-8" }));
    expect(res).toEqual({ error: "Something went wrong. Please try again." });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("calls requireAdmin before any write, and writes nothing when it rejects", async () => {
    requireAdmin.mockRejectedValue(new Error("FORBIDDEN"));
    await expect(
      bulkLearnUnitsAction(undefined, fd({ block: "WABC01,HHC 1-8" })),
    ).rejects.toThrow("FORBIDDEN");
    // Not just that the call threw — the batch must never have reached
    // learnUnits. If requireAdmin() were dropped (or moved after the write),
    // learnUnits would still have fired here.
    expect(learnUnits).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
