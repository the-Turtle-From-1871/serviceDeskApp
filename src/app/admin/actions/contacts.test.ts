import { describe, it, expect, vi, beforeEach } from "vitest";

const requireAdmin = vi.fn();
const createContact = vi.fn();
const updateContact = vi.fn();
const deleteContact = vi.fn();
const revalidatePath = vi.fn();

// vi.mock factories are hoisted above ordinary top-level statements, so a
// plain `class` declaration referenced inside a factory hits the temporal
// dead zone. vi.hoisted() is the documented escape hatch: it hoists this
// initializer itself, ahead of the vi.mock calls below.
const { ContactError } = vi.hoisted(() => {
  class ContactError extends Error {
    code: "DUPLICATE_EMAIL" | "NOT_FOUND";
    constructor(code: "DUPLICATE_EMAIL" | "NOT_FOUND") {
      super(code);
      this.code = code;
      this.name = "ContactError";
    }
  }
  return { ContactError };
});

vi.mock("@/lib/authz", () => ({ requireAdmin: () => requireAdmin() }));
vi.mock("@/modules/contacts/contacts.service", () => ({
  createContact: (i: unknown, by: string) => createContact(i, by),
  updateContact: (i: unknown) => updateContact(i),
  deleteContact: (id: string) => deleteContact(id),
}));
vi.mock("@/modules/contacts/contacts.errors", () => ({ ContactError }));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));

import { createContactAction, updateContactAction, deleteContactAction } from "./contacts";

const ADMIN = { id: "admin-1", role: "ADMIN" as const, name: "Admin", email: "a@x.mil" };

function fd(over: Record<string, string> = {}) {
  const f = new FormData();
  f.set("firstName", "Jane");
  f.set("lastName", "Doe");
  f.set("email", "jane@unit.mil");
  for (const [k, v] of Object.entries(over)) f.set(k, v);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAdmin.mockResolvedValue(ADMIN);
  createContact.mockResolvedValue({ id: "c1" });
  updateContact.mockResolvedValue({ id: "c1" });
  deleteContact.mockResolvedValue(undefined);
});

describe("createContactAction", () => {
  it("checks admin before touching the service", async () => {
    requireAdmin.mockRejectedValue(new Error("FORBIDDEN"));
    await expect(createContactAction(undefined, fd())).rejects.toThrow("FORBIDDEN");
    expect(createContact).not.toHaveBeenCalled();
  });

  it("takes createdById from the session, never from the form", async () => {
    await createContactAction(undefined, fd({ createdById: "attacker" }));
    expect(createContact).toHaveBeenCalledWith(expect.anything(), "admin-1");
  });

  it("rejects invalid input without calling the service", async () => {
    const res = await createContactAction(undefined, fd({ email: "not-an-email" }));
    expect(res).toHaveProperty("error");
    expect(createContact).not.toHaveBeenCalled();
  });

  it("rejects a missing last name", async () => {
    const res = await createContactAction(undefined, fd({ lastName: "  " }));
    expect(res).toEqual({ error: "Last name is required" });
  });

  it("maps a duplicate email to a friendly message", async () => {
    createContact.mockRejectedValue(new ContactError("DUPLICATE_EMAIL"));
    expect(await createContactAction(undefined, fd()))
      .toEqual({ error: "A contact with that email already exists." });
  });

  it("returns a generic message and does not leak an unexpected error", async () => {
    createContact.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.1:5432"));
    const res = await createContactAction(undefined, fd());
    expect(res).toEqual({ error: "Something went wrong." });
    expect(JSON.stringify(res)).not.toContain("ECONNREFUSED");
  });

  it("revalidates the users page on success", async () => {
    expect(await createContactAction(undefined, fd())).toEqual({ ok: true });
    expect(revalidatePath).toHaveBeenCalledWith("/admin/users");
  });
});

describe("updateContactAction", () => {
  it("checks admin first", async () => {
    requireAdmin.mockRejectedValue(new Error("FORBIDDEN"));
    await expect(updateContactAction(undefined, fd({ id: "c1" }))).rejects.toThrow("FORBIDDEN");
    expect(updateContact).not.toHaveBeenCalled();
  });

  it("requires an id", async () => {
    const res = await updateContactAction(undefined, fd());
    expect(res).toHaveProperty("error");
    expect(updateContact).not.toHaveBeenCalled();
  });

  it("maps a duplicate email to a friendly message", async () => {
    updateContact.mockRejectedValue(new ContactError("DUPLICATE_EMAIL"));
    expect(await updateContactAction(undefined, fd({ id: "c1" })))
      .toEqual({ error: "A contact with that email already exists." });
  });

  it("revalidates on success", async () => {
    expect(await updateContactAction(undefined, fd({ id: "c1" }))).toEqual({ ok: true });
    expect(revalidatePath).toHaveBeenCalledWith("/admin/users");
  });
});

describe("deleteContactAction", () => {
  it("checks admin first", async () => {
    requireAdmin.mockRejectedValue(new Error("FORBIDDEN"));
    const f = new FormData();
    f.set("id", "c1");
    await expect(deleteContactAction(f)).rejects.toThrow("FORBIDDEN");
    expect(deleteContact).not.toHaveBeenCalled();
  });

  it("deletes and revalidates", async () => {
    const f = new FormData();
    f.set("id", "c1");
    await deleteContactAction(f);
    expect(deleteContact).toHaveBeenCalledWith("c1");
    expect(revalidatePath).toHaveBeenCalledWith("/admin/users");
  });

  it("swallows a NOT_FOUND so a double-submit does not 500", async () => {
    deleteContact.mockRejectedValue(new ContactError("NOT_FOUND"));
    const f = new FormData();
    f.set("id", "gone");
    await expect(deleteContactAction(f)).resolves.toBeUndefined();
  });

  it("returns without calling the service when id is missing", async () => {
    const f = new FormData();
    await expect(deleteContactAction(f)).resolves.toBeUndefined();
    expect(deleteContact).not.toHaveBeenCalled();
  });

  it("rejects with a generic message and does not leak an unexpected error", async () => {
    deleteContact.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.1:5432"));
    const f = new FormData();
    f.set("id", "c1");
    let error: Error | undefined;
    try {
      await deleteContactAction(f);
    } catch (e) {
      error = e as Error;
    }
    expect(error).toBeInstanceOf(Error);
    expect(JSON.stringify(error?.message)).not.toContain("ECONNREFUSED");
  });
});
