import "dotenv/config";

import prisma from "../src/lib/prisma";
import { hashPassword } from "../src/lib/password";
import { UNIT_SEED } from "./units.data";

async function seedUnits() {
  for (const u of UNIT_SEED) {
    const abbreviation = u.abbreviation.toUpperCase();
    await prisma.unit.upsert({
      where: { abbreviation },
      update: { fullName: u.fullName },
      create: { abbreviation, fullName: u.fullName },
    });
  }
  console.log(`Seeded ${UNIT_SEED.length} units.`);
}

async function seedAdmin() {
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

async function main() {
  await seedUnits();
  await seedAdmin();
}

main().finally(() => prisma.$disconnect());
