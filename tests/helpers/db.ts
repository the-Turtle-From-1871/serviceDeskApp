import { execSync } from "node:child_process";
import prisma from "@/lib/prisma";

export async function resetDb() {
  // Safety belt: this TRUNCATE must only ever run against the test database.
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("handreceipt_test")) {
    throw new Error(
      `resetDb() refused to run: DATABASE_URL does not target handreceipt_test (got: ${url})`
    );
  }

  // All three tables exist as of P2 Task 1 (Item + Transfer created together).
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "Transfer","Item","User","Unit" RESTART IDENTITY CASCADE;`
  );
}

export function migrateTestDb() {
  // Apply migrations to the TEST database. DATABASE_URL is already set to the
  // test DB by setup-env.ts, so pass it through explicitly to the CLI.
  execSync("npx prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
    stdio: "inherit",
  });
}
