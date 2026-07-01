import type { Role, User } from "@prisma/client";
import prisma from "@/lib/prisma";
import { hashPassword } from "@/lib/password";
import { newUserSchema, type NewUserInput } from "./users.schema";

export async function createUser(input: NewUserInput): Promise<User> {
  const data = newUserSchema.parse(input);
  return prisma.user.create({
    data: { name: data.name, email: data.email, role: data.role, passwordHash: await hashPassword(data.password) },
  });
}

export function setUserActive(id: string, isActive: boolean): Promise<User> {
  return prisma.user.update({ where: { id }, data: { isActive } });
}

export function setUserRole(id: string, role: Role): Promise<User> {
  return prisma.user.update({ where: { id }, data: { role } });
}

export function listUsers(): Promise<User[]> {
  return prisma.user.findMany({ orderBy: { name: "asc" } });
}
