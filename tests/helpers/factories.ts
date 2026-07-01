import prisma from "@/lib/prisma";

let n = 0;
export function makeUser(overrides: Partial<{ name: string; role: "ADMIN" | "USER"; isActive: boolean }> = {}) {
  n += 1;
  return prisma.user.create({
    data: {
      name: overrides.name ?? `User${n}`,
      email: `user${n}@x.co`,
      passwordHash: "x",
      role: overrides.role ?? "USER",
      isActive: overrides.isActive ?? true,
    },
  });
}

export function makeItem(createdById: string, overrides: Partial<{ currentHolderId: string; status: "ACTIVE" | "RETIRED" }> = {}) {
  n += 1;
  return prisma.item.create({
    data: {
      make: "Make", model: "Model", serialNumber: `SN${n}`,
      createdById,
      currentHolderId: overrides.currentHolderId,
      status: overrides.status ?? "ACTIVE",
    },
  });
}
