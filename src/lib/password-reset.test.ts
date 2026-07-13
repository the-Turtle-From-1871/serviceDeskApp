import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock prisma with the surface these functions touch. Built via vi.hoisted so
// the objects exist when the hoisted vi.mock factory runs. `default` is the
// module's default export (`import prisma from "@/lib/prisma"`).
const { passwordResetToken, user, $transaction, prismaMock } = vi.hoisted(() => {
  const passwordResetToken = { findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn() };
  const user = { update: vi.fn() };
  const $transaction = vi.fn();
  return { passwordResetToken, user, $transaction, prismaMock: { passwordResetToken, user, $transaction } };
});
vi.mock("@/lib/prisma", () => ({ default: prismaMock, prisma: prismaMock }));

// Deterministic, side-effect-free stubs for the crypto helpers.
vi.mock("@/lib/password", () => ({ hashPassword: vi.fn(async (p: string) => `hashed:${p}`) }));
vi.mock("@/lib/reset-token", () => ({
  generateResetToken: vi.fn(() => "raw-token"),
  hashToken: vi.fn((t: string) => `sha:${t}`),
}));

import { resetPasswordWithToken } from "./password-reset";
import { hashPassword } from "@/lib/password";

const HOUR = 60 * 60 * 1000;

beforeEach(() => {
  vi.clearAllMocks();
  // Default: transaction just resolves; claim succeeds unless overridden.
  $transaction.mockResolvedValue(undefined);
  passwordResetToken.updateMany.mockResolvedValue({ count: 1 });
});

describe("resetPasswordWithToken", () => {
  it("returns false for an expired token (never hashes or claims)", async () => {
    passwordResetToken.findUnique.mockResolvedValue({
      id: "t1",
      userId: "u1",
      usedAt: null,
      expiresAt: new Date(Date.now() - 1000),
      user: { isActive: true },
    });

    expect(await resetPasswordWithToken("raw", "NewPass1!")).toBe(false);
    expect(passwordResetToken.updateMany).not.toHaveBeenCalled();
    expect(hashPassword).not.toHaveBeenCalled();
    expect(user.update).not.toHaveBeenCalled();
  });

  it("returns false when the token is already used", async () => {
    passwordResetToken.findUnique.mockResolvedValue({
      id: "t1",
      userId: "u1",
      usedAt: new Date(),
      expiresAt: new Date(Date.now() + HOUR),
      user: { isActive: true },
    });

    expect(await resetPasswordWithToken("raw", "NewPass1!")).toBe(false);
    expect(passwordResetToken.updateMany).not.toHaveBeenCalled();
    expect(hashPassword).not.toHaveBeenCalled();
  });

  it("returns false when the owning user is deactivated", async () => {
    passwordResetToken.findUnique.mockResolvedValue({
      id: "t1",
      userId: "u1",
      usedAt: null,
      expiresAt: new Date(Date.now() + HOUR),
      user: { isActive: false },
    });

    expect(await resetPasswordWithToken("raw", "NewPass1!")).toBe(false);
    expect(passwordResetToken.updateMany).not.toHaveBeenCalled();
    expect(hashPassword).not.toHaveBeenCalled();
    expect(user.update).not.toHaveBeenCalled();
  });

  it("happy path: atomically claims the token, then hashes and updates the password", async () => {
    passwordResetToken.findUnique.mockResolvedValue({
      id: "t1",
      userId: "u1",
      usedAt: null,
      expiresAt: new Date(Date.now() + HOUR),
      user: { isActive: true },
    });
    passwordResetToken.updateMany.mockResolvedValueOnce({ count: 1 });

    expect(await resetPasswordWithToken("raw", "NewPass1!")).toBe(true);

    // The claim is a compare-and-set gated on { id, usedAt: null }.
    expect(passwordResetToken.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: "t1", usedAt: null },
      data: { usedAt: expect.any(Date) },
    });
    // Only after a successful claim do we hash and persist.
    expect(hashPassword).toHaveBeenCalledWith("NewPass1!");
    // The persisted user.update stamps passwordChangedAt atomically with the new
    // hash so auth.ts can revoke sessions minted before the reset.
    expect(user.update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { passwordHash: "hashed:NewPass1!", passwordChangedAt: expect.any(Date) },
    });
    expect($transaction).toHaveBeenCalledTimes(1);
  });

  it("returns false when the claim loses the race (count === 0) — no hash, no update", async () => {
    passwordResetToken.findUnique.mockResolvedValue({
      id: "t1",
      userId: "u1",
      usedAt: null,
      expiresAt: new Date(Date.now() + HOUR),
      user: { isActive: true },
    });
    passwordResetToken.updateMany.mockResolvedValueOnce({ count: 0 });

    expect(await resetPasswordWithToken("raw", "NewPass1!")).toBe(false);
    expect(hashPassword).not.toHaveBeenCalled();
    expect($transaction).not.toHaveBeenCalled();
  });
});
