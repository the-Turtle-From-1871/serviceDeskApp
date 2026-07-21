import { describe, it, expect, vi, beforeEach } from "vitest";

const requireUser = vi.fn();
const getAuditSignature = vi.fn();

vi.mock("@/lib/authz", () => ({
  requireUser: () => requireUser(),
  AuthError: class AuthError extends Error {},
}));
vi.mock("@/modules/audit/audit.service", () => ({
  getAuditSignature: (id: string) => getAuditSignature(id),
}));

import { revealAuditSignatureAction } from "./audit";

beforeEach(() => {
  vi.clearAllMocks();
  requireUser.mockResolvedValue({ id: "u1", role: "USER" });
});

describe("revealAuditSignatureAction", () => {
  it("returns the signature image for a signed-in staff member", async () => {
    getAuditSignature.mockResolvedValue("data:image/png;base64,AAA");
    const res = await revealAuditSignatureAction("a1");
    expect(res).toBe("data:image/png;base64,AAA");
    expect(getAuditSignature).toHaveBeenCalledWith("a1");
  });

  it("returns null when the audit no longer exists", async () => {
    getAuditSignature.mockResolvedValue(null);
    expect(await revealAuditSignatureAction("gone")).toBeNull();
  });

  it("requires a signed-in user (rejects when requireUser throws)", async () => {
    requireUser.mockRejectedValueOnce(new Error("UNAUTHENTICATED"));
    await expect(revealAuditSignatureAction("a1")).rejects.toThrow();
    expect(getAuditSignature).not.toHaveBeenCalled();
  });
});
