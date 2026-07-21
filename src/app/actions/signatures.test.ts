import { describe, it, expect, vi, beforeEach } from "vitest";

const requireAdmin = vi.fn();
const getOwnedSignature = vi.fn();

vi.mock("@/lib/authz", () => ({
  requireAdmin: () => requireAdmin(),
  AuthError: class AuthError extends Error {},
}));
vi.mock("@/modules/signatures/signatures.service", () => ({
  createSignature: vi.fn(),
  deleteSignature: vi.fn(),
  getOwnedSignature: (id: string, uid: string) => getOwnedSignature(id, uid),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { revealOwnSignatureAction } from "./signatures";

beforeEach(() => {
  vi.clearAllMocks();
  requireAdmin.mockResolvedValue({ id: "admin-1", role: "ADMIN" });
});

describe("revealOwnSignatureAction", () => {
  it("returns the acting admin's own signature image, scoped by user id", async () => {
    getOwnedSignature.mockResolvedValue({ name: "SGT Smith", image: "data:image/png;base64,AAA" });
    expect(await revealOwnSignatureAction("sig-1")).toBe("data:image/png;base64,AAA");
    expect(getOwnedSignature).toHaveBeenCalledWith("sig-1", "admin-1");
  });

  it("returns null for a bogus id or another admin's signature", async () => {
    getOwnedSignature.mockResolvedValue(null);
    expect(await revealOwnSignatureAction("nope")).toBeNull();
  });

  it("requires an admin (rejects and never reads a signature when requireAdmin throws)", async () => {
    requireAdmin.mockRejectedValueOnce(new Error("FORBIDDEN"));
    await expect(revealOwnSignatureAction("sig-1")).rejects.toThrow();
    expect(getOwnedSignature).not.toHaveBeenCalled();
  });
});
