import "server-only";
import prisma from "@/lib/prisma";
import { hashPassword } from "@/lib/password";
import { generateResetToken, hashToken } from "@/lib/reset-token";

const EXPIRY_MS = 60 * 60 * 1000; // 1 hour

// Creates a single-use reset token for the user and returns the RAW token to
// email. We deliberately do NOT pre-invalidate the user's prior unused tokens:
// allowing multiple concurrent single-use, 1-hour tokens means a failed email
// send (or an attacker spamming requests) no longer strands the user by killing
// a link they already received. Consume-time invalidation in
// resetPasswordWithToken still ensures a successful reset kills all outstanding
// links.
export async function createPasswordResetToken(userId: string): Promise<string> {
  const raw = generateResetToken();
  await prisma.passwordResetToken.create({
    data: { userId, tokenHash: hashToken(raw), expiresAt: new Date(Date.now() + EXPIRY_MS) },
  });
  return raw;
}

// Validates the raw token, sets the new password, and consumes the token (plus
// any other outstanding tokens for that user). Returns false if the token is
// missing, expired, already used, or its owning user is deactivated.
export async function resetPasswordWithToken(rawToken: string, newPassword: string): Promise<boolean> {
  const row = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    include: { user: { select: { isActive: true } } },
  });
  if (!row || row.usedAt || row.expiresAt.getTime() < Date.now()) return false;
  // Never mutate a deactivated account's passwordHash via an outstanding token.
  if (!row.user?.isActive) return false;

  // Atomically claim the token (compare-and-set) BEFORE hashing/updating so two
  // concurrent requests with the same token can't both proceed — the loser gets
  // count === 0 and bails.
  const claim = await prisma.passwordResetToken.updateMany({
    where: { id: row.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (claim.count === 0) return false;

  const passwordHash = await hashPassword(newPassword);
  await prisma.$transaction([
    prisma.user.update({ where: { id: row.userId }, data: { passwordHash, passwordChangedAt: new Date() } }),
    prisma.passwordResetToken.updateMany({ where: { userId: row.userId, usedAt: null }, data: { usedAt: new Date() } }),
  ]);
  return true;
}
