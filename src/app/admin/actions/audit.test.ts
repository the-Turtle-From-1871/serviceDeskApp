import { describe, it, expect, vi, beforeEach } from "vitest";

const requireAdmin = vi.fn();
const getItem = vi.fn();
const getOwnedSignature = vi.fn();
const recordAudit = vi.fn();
const revalidatePath = vi.fn();

vi.mock("@/lib/authz", () => ({
  requireAdmin: () => requireAdmin(),
  AuthError: class AuthError extends Error {},
}));
vi.mock("@/modules/items/items.service", () => ({
  getItem: (id: string) => getItem(id),
}));
vi.mock("@/modules/signatures/signatures.service", () => ({
  getOwnedSignature: (id: string, userId: string) => getOwnedSignature(id, userId),
}));
vi.mock("@/modules/audit/audit.service", () => ({
  recordAudit: (input: unknown) => recordAudit(input),
}));
vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => revalidatePath(path),
}));

import { markAuditedAction } from "./audit";

const ADMIN = { id: "admin-1", role: "ADMIN" as const, name: "Sgt Admin", email: "admin@x.mil" };

function fd(entries: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAdmin.mockResolvedValue(ADMIN);
  getItem.mockResolvedValue({ id: "i1", status: "ACTIVE" });
  getOwnedSignature.mockResolvedValue({ name: "SFC Tech", image: "data:image/png;base64,AAA" });
});

describe("markAuditedAction", () => {
  it("records the audit with the signer resolved server-side and revalidates", async () => {
    const res = await markAuditedAction(undefined, fd({ itemId: "i1", signatureId: "sig-1" }));
    expect(res).toEqual({ ok: true });
    expect(getOwnedSignature).toHaveBeenCalledWith("sig-1", "admin-1");
    expect(recordAudit).toHaveBeenCalledWith({
      itemId: "i1",
      auditedById: "admin-1",
      auditedByName: "Sgt Admin",
      signerName: "SFC Tech",
      signatureImage: "data:image/png;base64,AAA",
    });
    expect(revalidatePath).toHaveBeenCalledWith("/i/i1");
    expect(revalidatePath).toHaveBeenCalledWith("/items");
  });

  it("rejects a retired item without recording", async () => {
    getItem.mockResolvedValueOnce({ id: "i1", status: "RETIRED" });
    const res = await markAuditedAction(undefined, fd({ itemId: "i1", signatureId: "sig-1" }));
    expect(res.error).toBeTruthy();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("rejects a signature the admin does not own", async () => {
    getOwnedSignature.mockResolvedValueOnce(null);
    const res = await markAuditedAction(undefined, fd({ itemId: "i1", signatureId: "sig-x" }));
    expect(res.error).toBeTruthy();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("rejects missing input", async () => {
    const res = await markAuditedAction(undefined, fd({ itemId: "i1" }));
    expect(res.error).toBeTruthy();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("propagates the auth guard (non-admin cannot record)", async () => {
    requireAdmin.mockRejectedValueOnce(new Error("FORBIDDEN"));
    await expect(markAuditedAction(undefined, fd({ itemId: "i1", signatureId: "sig-1" }))).rejects.toThrow();
    expect(recordAudit).not.toHaveBeenCalled();
  });
});
