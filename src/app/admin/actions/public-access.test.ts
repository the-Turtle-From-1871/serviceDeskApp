import { describe, it, expect, vi, beforeEach } from "vitest";

const requireAdmin = vi.fn();
const setPin = vi.fn();
const revalidatePath = vi.fn();

vi.mock("@/lib/authz", () => ({ requireAdmin: () => requireAdmin() }));
vi.mock("@/lib/public-access", () => ({ setPin: (p: string, u: string) => setPin(p, u) }));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));

import { setPublicAccessPinAction } from "./public-access";

const ADMIN = { id: "admin-1", role: "ADMIN" as const, name: "Admin", email: "a@x.mil" };

function fd(entries: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAdmin.mockResolvedValue(ADMIN);
  setPin.mockResolvedValue(undefined);
});

describe("setPublicAccessPinAction", () => {
  it("requires admin (propagates the authz error)", async () => {
    requireAdmin.mockRejectedValue(new Error("FORBIDDEN"));
    await expect(setPublicAccessPinAction(undefined, fd({ pin: "12345678", confirm: "12345678" })))
      .rejects.toThrow("FORBIDDEN");
    expect(setPin).not.toHaveBeenCalled();
  });

  it("rejects a non-8-digit PIN", async () => {
    const res = await setPublicAccessPinAction(undefined, fd({ pin: "123", confirm: "123" }));
    expect(res).toEqual({ error: "PIN must be exactly 8 digits." });
    expect(setPin).not.toHaveBeenCalled();
  });

  it("rejects a mismatched confirmation", async () => {
    const res = await setPublicAccessPinAction(undefined, fd({ pin: "12345678", confirm: "87654321" }));
    expect(res).toEqual({ error: "PINs do not match." });
    expect(setPin).not.toHaveBeenCalled();
  });

  it("sets the PIN with the acting admin id and revalidates /admin", async () => {
    const res = await setPublicAccessPinAction(undefined, fd({ pin: "12345678", confirm: "12345678" }));
    expect(res).toEqual({ ok: true });
    expect(setPin).toHaveBeenCalledWith("12345678", "admin-1");
    expect(revalidatePath).toHaveBeenCalledWith("/admin");
  });
});
