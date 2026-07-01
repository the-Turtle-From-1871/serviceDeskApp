import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Migrations (DDL) need a DIRECT connection. With a pooled Postgres such as
    // Neon, DATABASE_URL points at the transaction pooler (used by the app at
    // runtime), which can't run migrations — so prefer DIRECT_URL for the CLI
    // and fall back to DATABASE_URL for local dev where there is only one URL.
    url: process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? "",
  },
});
