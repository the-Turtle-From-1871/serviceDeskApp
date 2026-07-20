import type { Role, User } from "@prisma/client";
import prisma from "@/lib/prisma";
import { hashPassword, verifyPassword } from "@/lib/password";
import { newUserSchema, type NewUserInput } from "./users.schema";
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

// Single source of truth for the active/inactive transition. Stamp deactivatedAt
// when the account goes inactive (used by the account-purge worker) and clear it
// on reactivation, so the timestamp always reflects the *current* deactivation.
export function setUserActive(id: string, isActive: boolean): Promise<User> {
  return prisma.user.update({
    where: { id },
    data: { isActive, deactivatedAt: isActive ? null : new Date() },
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
    data: { passwordHash: await hashPassword(newPassword) },
  });
}

// Sets or clears the caller's reusable saved signature (a PNG data URL, or null
// to remove it). Validation of the data URL happens at the action layer.
export function updateUserSignature(id: string, signature: string | null): Promise<void> {
  return prisma.user.update({ where: { id }, data: { signatureImage: signature } }).then(() => undefined);
}
