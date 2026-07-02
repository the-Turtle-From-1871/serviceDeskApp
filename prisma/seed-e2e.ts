// tsx does not auto-load .env (unlike the Prisma CLI, which loads it via
// prisma.config.ts's `import "dotenv/config"`). Load it explicitly here so
// src/lib/prisma.ts's driver adapter sees DATABASE_URL.
import "dotenv/config";

import prisma from "../src/lib/prisma";
import { hashPassword } from "../src/lib/password";

async function main() {
  const pw = await hashPassword("password123");
  const admin = await prisma.user.upsert({ where: { email: "admin@example.com" }, update: {},
    create: { name: "Admin", email: "admin@example.com", passwordHash: pw, role: "ADMIN" } });
  await prisma.user.upsert({ where: { email: "a@example.com" }, update: {},
    create: { name: "Alice", email: "a@example.com", passwordHash: pw, role: "USER" } });
  await prisma.user.upsert({ where: { email: "b@example.com" }, update: {},
    create: { name: "Bob", email: "b@example.com", passwordHash: pw, role: "USER" } });
  await prisma.item.create({ data: { make: "Dell", model: "5540", serialNumber: "E2E-1", createdById: admin.id } });
  console.log("E2E seed done");
}
main().finally(() => prisma.$disconnect());
