import { describe, it, expect, vi, beforeEach } from "vitest";

const findUnique = vi.fn();
const upsert = vi.fn();
const hashPassword = vi.fn();
const verifyPassword = vi.fn();

vi.mock("@/lib/prisma", () => ({
  default: { publicAccessSetting: { findUnique: (a: unknown) => findUnique(a), upsert: (a: unknown) => upsert(a) } },
}));
vi.mock("@/lib/password", () => ({
  hashPassword: (p: string) => hashPassword(p),
  verifyPassword: (p: string, h: string) => verifyPassword(p, h),
}));

import { getPinHash, verifyPin, setPin, getPinMeta } from "./public-access";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("verifyPin", () => {
  it("returns false when no PIN is configured", async () => {
    findUnique.mockResolvedValue(null);
    expect(await verifyPin("12345678")).toBe(false);
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it("bcrypt-compares against the stored hash when configured", async () => {
    findUnique.mockResolvedValue({ pinHash: "HASH" });
    verifyPassword.mockResolvedValue(true);
    expect(await verifyPin("12345678")).toBe(true);
    expect(verifyPassword).toHaveBeenCalledWith("12345678", "HASH");
  });
});

describe("setPin", () => {
  it("hashes the PIN and upserts the singleton row with the acting admin", async () => {
    hashPassword.mockResolvedValue("HASHED");
    await setPin("87654321", "admin-1");
    expect(hashPassword).toHaveBeenCalledWith("87654321");
    const arg = upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ id: "singleton" });
    expect(arg.create).toMatchObject({ id: "singleton", pinHash: "HASHED", updatedById: "admin-1" });
    expect(arg.update).toMatchObject({ pinHash: "HASHED", updatedById: "admin-1" });
  });
});

describe("getPinMeta", () => {
  it("returns null when unset", async () => {
    findUnique.mockResolvedValue(null);
    expect(await getPinMeta()).toBeNull();
  });

  it("returns updatedAt + updater name", async () => {
    const when = new Date("2026-07-21T00:00:00Z");
    findUnique.mockResolvedValue({ updatedAt: when, updatedBy: { name: "Jane" } });
    expect(await getPinMeta()).toEqual({ updatedAt: when, updatedByName: "Jane" });
  });
});
