import { beforeEach, describe, expect, it, vi } from "vitest";

const { user, prismaMock } = vi.hoisted(() => {
  const user = { findUnique: vi.fn() };
  return { user, prismaMock: { user } };
});
vi.mock("@/lib/prisma", () => ({ default: prismaMock, prisma: prismaMock }));

const verifyPassword = vi.hoisted(() => vi.fn());
vi.mock("@/lib/password", () => ({ verifyPassword: (a: string, b: string) => verifyPassword(a, b) }));

import { checkCredentials } from "./credentials";

const row = (over: Record<string, unknown> = {}) => ({
  id: "u1",
  name: "Jane",
  email: "jane@unit.mil",
  role: "VIEWER",
  passwordHash: "hash",
  isActive: true,
  emailVerifiedAt: new Date(),
  ...over,
});

const creds = { email: "jane@unit.mil", password: "correct horse" };

beforeEach(() => {
  vi.clearAllMocks();
  verifyPassword.mockResolvedValue(true);
});

describe("checkCredentials", () => {
  it("admits a verified, active account", async () => {
    user.findUnique.mockResolvedValue(row());
    await expect(checkCredentials(creds)).resolves.toEqual({
      ok: true,
      user: { id: "u1", name: "Jane", email: "jane@unit.mil", role: "VIEWER" },
    });
  });

  it("never returns the password hash to the caller", async () => {
    user.findUnique.mockResolvedValue(row());
    const res = await checkCredentials(creds);
    expect(JSON.stringify(res)).not.toContain("hash");
  });

  it("reports `unverified` for a confirmed password on an unconfirmed address", async () => {
    user.findUnique.mockResolvedValue(row({ emailVerifiedAt: null }));
    await expect(checkCredentials(creds)).resolves.toEqual({ ok: false, reason: "unverified" });
  });

  // THE oracle guard. A wrong password on an unverified account must be
  // indistinguishable from a wrong password on any other account — otherwise the
  // login form answers "does this address have an account?" for anyone who asks.
  it("reports plain `invalid` for a WRONG password, even when unverified", async () => {
    verifyPassword.mockResolvedValue(false);
    user.findUnique.mockResolvedValue(row({ emailVerifiedAt: null }));
    await expect(checkCredentials(creds)).resolves.toEqual({ ok: false, reason: "invalid" });
  });

  it("checks the password BEFORE consulting the verification state", async () => {
    user.findUnique.mockResolvedValue(row({ emailVerifiedAt: null }));
    await checkCredentials(creds);
    expect(verifyPassword).toHaveBeenCalledTimes(1);
  });

  it("reports `invalid` for an unknown account without touching bcrypt", async () => {
    user.findUnique.mockResolvedValue(null);
    await expect(checkCredentials(creds)).resolves.toEqual({ ok: false, reason: "invalid" });
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it("reports `invalid` for a deactivated account, verified or not", async () => {
    user.findUnique.mockResolvedValue(row({ isActive: false }));
    await expect(checkCredentials(creds)).resolves.toEqual({ ok: false, reason: "invalid" });
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it("reports `invalid` for a malformed submission without hitting the database", async () => {
    await expect(checkCredentials({ email: "nope", password: "x" }))
      .resolves.toEqual({ ok: false, reason: "invalid" });
    expect(user.findUnique).not.toHaveBeenCalled();
  });

  it("lowercases and trims the email before lookup", async () => {
    user.findUnique.mockResolvedValue(row());
    await checkCredentials({ email: "  JANE@Unit.MIL  ", password: "x" });
    expect(user.findUnique).toHaveBeenCalledWith({ where: { email: "jane@unit.mil" } });
  });
});
