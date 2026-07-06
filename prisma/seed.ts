// tsx does not auto-load .env (unlike the Prisma CLI, which loads it via
// prisma.config.ts's `import "dotenv/config"`). Load it explicitly here so
// src/lib/prisma.ts's driver adapter sees DATABASE_URL.
import "dotenv/config";

import prisma from "../src/lib/prisma";
import { hashPassword } from "../src/lib/password";

async function main() {
  // No hardcoded credentials: the initial admin identity/password must come
  // from the environment. Fail clearly if they're missing rather than falling
  // back to a well-known default.
  const email = process.env.SEED_ADMIN_EMAIL;
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error(
      "SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD must be set to seed the initial admin. " +
        "Set them in your environment (e.g. .env) before running `npm run db:seed`.",
    );
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log(`Admin ${email} already exists — skipping.`);
    return;
  }

  await prisma.user.create({
    data: {
      name: "Administrator",
      email,
      passwordHash: await hashPassword(password),
      role: "ADMIN",
    },
  });
  console.log(`Seeded admin ${email}. Change this password after first login.`);
}

main().finally(() => prisma.$disconnect());
