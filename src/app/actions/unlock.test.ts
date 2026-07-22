import { describe, it, expect, vi, beforeEach } from "vitest";

const verifyPin = vi.fn();
const cookieSet = vi.fn();
const redirect = vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); });

vi.mock("@/lib/public-access", () => ({ verifyPin: (p: string) => verifyPin(p) }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: (...a: unknown[]) => cookieSet(...a) }) }));
vi.mock("next/navigation", () => ({ redirect: (u: string) => redirect(u) }));

import { unlockAction } from "./unlock";

function fd(entries: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_SECRET = "test-secret";
});

describe("unlockAction", () => {
  it("rejects a non-8-digit PIN without hitting verifyPin", async () => {
    const res = await unlockAction(undefined, fd({ pin: "12ab", next: "/i/x" }));
    expect(res).toEqual({ error: "Enter the 8-digit PIN." });
    expect(verifyPin).not.toHaveBeenCalled();
  });

  it("returns a generic error on an incorrect PIN", async () => {
    verifyPin.mockResolvedValue(false);
    const res = await unlockAction(undefined, fd({ pin: "00000000", next: "/i/x" }));
    expect(res).toEqual({ error: "Incorrect PIN." });
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it("sets the unlock cookie and redirects to the sanitized next on success", async () => {
    verifyPin.mockResolvedValue(true);
    await expect(unlockAction(undefined, fd({ pin: "12345678", next: "/i/abc" })))
      .rejects.toThrow("REDIRECT:/i/abc");
    expect(cookieSet).toHaveBeenCalledTimes(1);
    const [name, value, opts] = cookieSet.mock.calls[0];
    expect(name).toBe("pub_unlock"); // NODE_ENV is "test" -> not secure
    expect(typeof value).toBe("string");
    expect(opts).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", maxAge: 604800 });
  });

  it("redirects to / when next is an open-redirect attempt", async () => {
    verifyPin.mockResolvedValue(true);
    await expect(unlockAction(undefined, fd({ pin: "12345678", next: "https://evil.com" })))
      .rejects.toThrow("REDIRECT:/");
  });
});
