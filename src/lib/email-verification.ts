import "server-only";
import prisma from "@/lib/prisma";
import { generateResetToken, hashToken } from "@/lib/reset-token";

// 24 hours. Deliberately longer than a password reset's hour: a reset answers
// something the user is doing right now, while a sign-up confirmation is often
// opened the next morning, and an expired link there reads as a broken product
// rather than a security measure.
const EXPIRY_MS = 24 * 60 * 60 * 1000;

/** Creates a single-use verification token and returns the RAW value to email.
 *  Only its hash is stored, so a DB leak cannot be used to verify an address
 *  the leaker does not control. Mirrors createPasswordResetToken. */
export async function createEmailVerificationToken(userId: string): Promise<string> {
  const raw = generateResetToken();
  await prisma.emailVerificationToken.create({
    data: { userId, tokenHash: hashToken(raw), expiresAt: new Date(Date.now() + EXPIRY_MS) },
  });
  return raw;
}

/** Validates and consumes the token, stamping the user's `emailVerifiedAt`.
 *
 *  Returns `{ ok: false }` for a token that is unknown, expired, already used,
 *  or that lost the race to a concurrent claim — the caller renders one generic
 *  "invalid or expired" message for all four, because distinguishing them tells
 *  a stranger which tokens exist. */
export async function verifyEmailWithToken(
  rawToken: string,
): Promise<{ ok: true; userId: string } | { ok: false }> {
  const row = await prisma.emailVerificationToken.findUnique({
    where: { tokenHash: hashToken(rawToken) },
  });
  if (!row || row.usedAt || row.expiresAt.getTime() < Date.now()) return { ok: false };

  // Claim it BEFORE the user write (compare-and-set), so two clicks on the same
  // link cannot both proceed — the loser gets count === 0 and bails. Same shape,
  // and same reason, as resetPasswordWithToken.
  const claim = await prisma.emailVerificationToken.updateMany({
    where: { id: row.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (claim.count === 0) return { ok: false };

  await prisma.user.update({
    where: { id: row.userId },
    data: { emailVerifiedAt: new Date() },
  });
  return { ok: true, userId: row.userId };
}
