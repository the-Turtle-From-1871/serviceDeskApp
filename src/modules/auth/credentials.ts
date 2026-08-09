import "server-only";
import type { Role } from "@prisma/client";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { verifyPassword } from "@/lib/password";

export const credentialsSchema = z.object({
  email: z.string().trim().email().transform((v) => v.toLowerCase()),
  password: z.string().min(1),
});

/** Distinguishes "right password, unconfirmed address" from every other
 *  credential failure. Lives HERE rather than in src/auth.ts so that neither
 *  side has to load NextAuth (or mock it) just to name the case: auth.ts turns
 *  it into a thrown CredentialsSignin code, and loginAction reads it back off
 *  the error URL @auth/core returns. */
export const EMAIL_NOT_VERIFIED = "email_not_verified";

export type CredentialsUser = { id: string; name: string; email: string; role: Role };

/** Why a credential check failed.
 *
 *  `unverified` is the ONLY reason a caller may surface specifically, and only
 *  because reaching it already required the correct password. Everything else
 *  collapses to `invalid`, which the UI renders as one message. */
export type CredentialsResult =
  | { ok: true; user: CredentialsUser }
  | { ok: false; reason: "invalid" | "unverified" };

/**
 * The credential check, split out of `src/auth.ts` so it can be unit-tested
 * without booting NextAuth (which cannot load under vitest — see the note in
 * auth.rate-limit.test.ts).
 *
 * ORDER IS LOAD-BEARING. The password is verified BEFORE the email-verification
 * state is consulted, so "this address is registered but unconfirmed" is only
 * ever disclosed to someone who has already proved they hold the password.
 * Checking verification first would turn the login form into an oracle for
 * "does an account exist for this address" — answerable by anyone, for any
 * address, with no credential at all.
 */
export async function checkCredentials(raw: unknown): Promise<CredentialsResult> {
  const parsed = credentialsSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({ where: { email } });
  // An unknown or deactivated account never reaches bcrypt: there is nothing to
  // compare against, and the timing difference is not worth the wasted work.
  if (!user || !user.isActive) return { ok: false, reason: "invalid" };

  if (!(await verifyPassword(password, user.passwordHash))) {
    return { ok: false, reason: "invalid" };
  }

  if (!user.emailVerifiedAt) return { ok: false, reason: "unverified" };

  return { ok: true, user: { id: user.id, name: user.name, email: user.email, role: user.role } };
}
