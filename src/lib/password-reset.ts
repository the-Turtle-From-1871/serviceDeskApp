import "server-only";
import prisma from "@/lib/prisma";
import { hashPassword } from "@/lib/password";
import { generateResetToken, hashToken } from "@/lib/reset-token";

const EXPIRY_MS = 60 * 60 * 1000; // 1 hour

// Creates a single-use reset token for the user and returns the RAW token to
// email. Any prior unused tokens for the user are invalidated first.
export async function createPasswordResetToken(userId: string): Promise<string> {
  const raw = generateResetToken();
  await prisma.$transaction([
    prisma.passwordResetToken.updateMany({ where: { userId, usedAt: null }, data: { usedAt: new Date() } }),
    prisma.passwordResetToken.create({
      data: { userId, tokenHash: hashToken(raw), expiresAt: new Date(Date.now() + EXPIRY_MS) },
    }),
  ]);
  return raw;
}

// Validates the raw token, sets the new password, and consumes the token (plus
// any other outstanding tokens for that user). Returns false if the token is
// missing, expired, or already used.
export async function resetPasswordWithToken(rawToken: string, newPassword: string): Promise<boolean> {
  const row = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hashToken(rawToken) } });
  if (!row || row.usedAt || row.expiresAt.getTime() < Date.now()) return false;

  const passwordHash = await hashPassword(newPassword);
  await prisma.$transaction([
    prisma.user.update({ where: { id: row.userId }, data: { passwordHash } }),
    prisma.passwordResetToken.updateMany({ where: { userId: row.userId, usedAt: null }, data: { usedAt: new Date() } }),
  ]);
  return true;
}
