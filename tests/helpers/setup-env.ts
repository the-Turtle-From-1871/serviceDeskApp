import { config } from "dotenv";
import { workerDbName } from "./test-db-name";

config({ path: ".env.test", override: true, quiet: true });

// Point this worker at its own database (provisioned in global-setup.ts).
// Without this, parallel files TRUNCATE each other through resetDb().
//
// DELIBERATELY VITEST_POOL_ID, NOT VITEST_WORKER_ID: despite the name,
// VITEST_WORKER_ID is "a unique identifier for each running worker,
// independent of maxWorkers" (Vitest 4 migration guide) — i.e. an
// ever-incrementing per-FILE counter with no upper bound, confirmed by
// reading node_modules/vitest/dist/chunks/cli-api.*.js (`let workerId = 0;
// … workerId: workerId++` per task, one task per file). Using it here sent
// files to "handreceipt_test_<hash>_17", "_26", etc., which global-setup.ts
// never provisions (it only creates 1..MAX_TEST_WORKERS) — every DB-backed
// test after the 8th distinct file failed with "database … does not exist".
// VITEST_POOL_ID is the one Vitest itself calls the JEST_WORKER_ID
// equivalent: a slot number bounded by maxWorkers and reused across files.
// With fileParallelism:false, Vitest forces maxWorkers=1, so this resolves
// to "1" for every file today — Task 4 (which lifts fileParallelism) is what
// makes this vary and is why the bound actually matters.
if (process.env.SKIP_TEST_DB !== "1" && process.env.DATABASE_URL) {
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${workerDbName(Number(process.env.VITEST_POOL_ID ?? 1))}`;
  // Prisma's default pool is physical_cpus*2+1 (~17 here). Eight workers would
  // open ~136 connections against Postgres's default max_connections of 100 and
  // the suite would die with errors that look nothing like their cause. Tests
  // are sequential WITHIN a worker, so two is plenty.
  url.searchParams.set("connection_limit", "2");
  process.env.DATABASE_URL = url.toString();
}

// jest-dom's matchers (toBeInTheDocument, toBeVisible, …) need a DOM, and this
// setup file runs for EVERY test file — the great majority of which are
// node-environment service tests that have no `document`. Registering them
// behind that check keeps the node suite untouched while making them available
// to any file that opts into jsdom with a `// @vitest-environment jsdom`
// docblock. Without this the dependency is installed but unreachable.
if (typeof document !== "undefined") {
  await import("@testing-library/jest-dom/vitest");
}
