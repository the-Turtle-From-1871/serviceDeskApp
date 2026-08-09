import type { Role, User } from "@prisma/client";
import prisma from "@/lib/prisma";
import { hashPassword, verifyPassword } from "@/lib/password";
import { newUserSchema, registerSchema, type NewUserInput, type RegisterInput } from "./users.schema";
import { PasswordChangeError } from "./users.errors";

export async function createUser(input: NewUserInput): Promise<User> {
  const data = newUserSchema.parse(input);
  return prisma.user.create({
    data: {
      rank: data.rank,
      name: data.name,
      email: data.email,
      unit: data.unit,
      contactNumber: data.contactNumber,
      role: data.role,
      passwordHash: await hashPassword(data.password),
    },
  });
}

// Self-service registration.
//
// Deliberately its OWN function rather than createUser with a role argument:
// there must be exactly one code path that can mint an account from an
// UNAUTHENTICATED request, and it must not be able to choose a role. VIEWER is
// hard-coded here, and `registerSchema` (newUserSchema minus `role`) means a
// crafted POST carrying role=ADMIN is stripped by z.object() before it arrives.
//
// `emailVerifiedAt` is left NULL: the address is an unproved claim until the
// emailed link is clicked, and src/auth.ts refuses sign-in until then.
export async function createSelfRegisteredUser(input: RegisterInput): Promise<User> {
  const data = registerSchema.parse(input);
  return prisma.user.create({
    data: {
      rank: data.rank,
      name: data.name,
      email: data.email,
      unit: data.unit,
      contactNumber: data.contactNumber,
      role: "VIEWER",
      passwordHash: await hashPassword(data.password),
    },
  });
}

// Single source of truth for the active/inactive transition. Stamp deactivatedAt
// when the account goes inactive (used by the account-purge worker) and clear it
// on reactivation, so the timestamp always reflects the *current* deactivation.
//
// Deactivating ALSO stamps passwordChangedAt, which is the token-revocation
// signal auth.ts's jwt callback compares against: without it the account's
// already-issued JWT stays valid until it expires (30 days). requireUser /
// requireAdmin re-read isActive per request, so the holder can't read or mutate
// anything either way — but the stale token still satisfies the coarse
// `!!req.auth` login check in src/proxy.ts, and with it the logged-in bypass of
// the public PIN gate. Stamping here revokes the token on its next request and
// closes that window. (The column name is about passwords; it is really "issued
// before this instant is no longer trusted". If a UI ever surfaces "password
// last changed", split this into its own `sessionsRevokedAt` column rather than
// stopping the stamp.)
//
// Reactivation deliberately does NOT clear the stamp: auth.ts only revokes when
// the DB stamp is non-null, so clearing it would resurrect the very tokens this
// revoked. The user signs in again and the fresh token seeds from it.
export function setUserActive(id: string, isActive: boolean): Promise<User> {
  const now = new Date();
  return prisma.user.update({
    where: { id },
    data: isActive
      ? { isActive, deactivatedAt: null }
      : { isActive, deactivatedAt: now, passwordChangedAt: now },
  });
}

export function setUserRole(id: string, role: Role): Promise<User> {
  return prisma.user.update({ where: { id }, data: { role } });
}

export function listUsers(): Promise<User[]> {
  return prisma.user.findMany({ orderBy: { name: "asc" } });
}

// Self-service password change: verify the caller's current password before
// setting the new hash. Throws PasswordChangeError("INVALID_CURRENT") when the
// current password does not match (or the user no longer exists).
//
// Stamps passwordChangedAt for the same reason setUserActive does, and it is
// NOT optional here: sessions are stateless JWTs with no revocation list, so
// this column is the only lever that invalidates an already-issued token. A
// user who changes their password because they believe it is compromised is
// performing the one remediation this app offers — without the stamp the
// attacker's stolen token survives the change and keeps full role-appropriate
// access until the 10-hour absolute bound from the ORIGINAL sign-in expires.
// The other two password-mutation paths (resetPasswordWithToken, and
// setUserActive on deactivation) already stamp it; this one being the odd one
// out was a silent hole, not a deliberate exemption.
//
// Note this revokes the CALLER's own token too, which is why
// changePasswordAction signs them out and sends them to /login rather than
// leaving them to discover it on their next navigation.
export async function changeUserPassword(
  id: string,
  currentPassword: string,
  newPassword: string
): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) {
    throw new PasswordChangeError("INVALID_CURRENT");
  }
  await prisma.user.update({
    where: { id },
    data: { passwordHash: await hashPassword(newPassword), passwordChangedAt: new Date() },
  });
}

// Sets or clears the caller's reusable saved signature (a PNG data URL, or null
// to remove it). Validation of the data URL happens at the action layer.
export function updateUserSignature(id: string, signature: string | null): Promise<void> {
  return prisma.user.update({ where: { id }, data: { signatureImage: signature } }).then(() => undefined);
}
