import { describe, it, expect, vi, beforeEach } from "vitest";

// Same shape as password-reset.test.ts: vi.hoisted so the objects exist when the
// hoisted vi.mock factory runs, and deterministic crypto stubs.
const { emailVerificationToken, user, prismaMock } = vi.hoisted(() => {
  const emailVerificationToken = { findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn() };
  const user = { update: vi.fn() };
  return { emailVerificationToken, user, prismaMock: { emailVerificationToken, user } };
});
vi.mock("@/lib/prisma", () => ({ default: prismaMock, prisma: prismaMock }));
vi.mock("@/lib/reset-token", () => ({
  generateResetToken: vi.fn(() => "raw-token"),
  hashToken: vi.fn((t: string) => `sha:${t}`),
}));

import { createEmailVerificationToken, verifyEmailWithToken } from "./email-verification";

const live = () => ({ id: "t1", userId: "u1", usedAt: null, expiresAt: new Date(Date.now() + 60_000) });

beforeEach(() => {
  vi.clearAllMocks();
  emailVerificationToken.create.mockResolvedValue({});
  emailVerificationToken.updateMany.mockResolvedValue({ count: 1 });
  user.update.mockResolvedValue({});
});

describe("createEmailVerificationToken", () => {
  it("returns the RAW token but stores only its hash", async () => {
    const raw = await createEmailVerificationToken("u1");
    expect(raw).toBe("raw-token");
    const arg = emailVerificationToken.create.mock.calls[0][0];
    expect(arg.data.tokenHash).toBe("sha:raw-token");
    // A DB leak must not yield anything usable to verify someone's address, so
    // no stored VALUE may be the raw token. Compared by equality, not by
    // substring: the stubbed hash here is `sha:${raw}` and would fail a
    // substring check purely because of the stub's shape, testing the mock
    // rather than the code.
    for (const value of Object.values(arg.data)) {
      expect(value).not.toBe(raw);
    }
  });

  it("sets an expiry in the future", async () => {
    await createEmailVerificationToken("u1");
    const { expiresAt } = emailVerificationToken.create.mock.calls[0][0].data;
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("verifyEmailWithToken", () => {
  it("refuses an unknown token", async () => {
    emailVerificationToken.findUnique.mockResolvedValue(null);
    expect(await verifyEmailWithToken("nope")).toEqual({ ok: false });
    expect(user.update).not.toHaveBeenCalled();
  });

  it("refuses an expired token", async () => {
    emailVerificationToken.findUnique.mockResolvedValue({ ...live(), expiresAt: new Date(Date.now() - 1000) });
    expect(await verifyEmailWithToken("x")).toEqual({ ok: false });
    expect(user.update).not.toHaveBeenCalled();
  });

  it("refuses an already-used token", async () => {
    emailVerificationToken.findUnique.mockResolvedValue({ ...live(), usedAt: new Date() });
    expect(await verifyEmailWithToken("x")).toEqual({ ok: false });
    expect(user.update).not.toHaveBeenCalled();
  });

  // Two clicks on the same emailed link must not both verify. The claim is a
  // compare-and-set, so the loser sees count === 0 and bails.
  it("refuses when a concurrent request already claimed the token", async () => {
    emailVerificationToken.findUnique.mockResolvedValue(live());
    emailVerificationToken.updateMany.mockResolvedValue({ count: 0 });
    expect(await verifyEmailWithToken("x")).toEqual({ ok: false });
    expect(user.update).not.toHaveBeenCalled();
  });

  it("claims the token BEFORE stamping the user", async () => {
    emailVerificationToken.findUnique.mockResolvedValue(live());
    await verifyEmailWithToken("x");
    expect(emailVerificationToken.updateMany.mock.invocationCallOrder[0])
      .toBeLessThan(user.update.mock.invocationCallOrder[0]);
  });

  it("stamps emailVerifiedAt and returns the user id on success", async () => {
    emailVerificationToken.findUnique.mockResolvedValue(live());
    expect(await verifyEmailWithToken("x")).toEqual({ ok: true, userId: "u1" });
    const arg = user.update.mock.calls[0][0];
    expect(arg.where).toEqual({ id: "u1" });
    expect(arg.data.emailVerifiedAt).toBeInstanceOf(Date);
  });

  it("looks the token up by HASH, never by raw value", async () => {
    emailVerificationToken.findUnique.mockResolvedValue(live());
    await verifyEmailWithToken("x");
    expect(emailVerificationToken.findUnique.mock.calls[0][0].where).toEqual({ tokenHash: "sha:x" });
  });
});
