import { execSync } from "node:child_process";
import { Client } from "pg";
import { config } from "dotenv";
import { MAX_TEST_WORKERS, templateDbName, workerDbName } from "./test-db-name";

// Runs ONCE per `vitest` invocation, before any worker starts.
//
// It replaces 25 per-file `beforeAll(migrateTestDb)` calls. Each of those
// shelled out to `npx prisma migrate deploy`, which costs ~3.5s in CLI startup
// alone — about 88s of a 332s run spent being told "No pending migrations".
//
// It also gives each worker its own database, which is what allows
// `fileParallelism` to be turned back on.

config({ path: ".env.test", override: true, quiet: true });

/** The same connection, pointed at a different database. */
function urlFor(dbName: string): string {
  const url = new URL(process.env.DATABASE_URL ?? "");
  url.pathname = `/${dbName}`;
  return url.toString();
}

async function withMaintenance<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  // CREATE/DROP DATABASE cannot run from inside the database being changed, so
  // this connects to the always-present `postgres` maintenance database.
  const connectionString = urlFor("postgres");
  const client = new Client({ connectionString });
  try {
    await client.connect();
  } catch (cause) {
    // Failing here once, with the fix, beats 46 files each producing a
    // connection error that looks unrelated to its cause.
    throw new Error(
      `Cannot reach Postgres at ${new URL(connectionString).host}.\n` +
        `Is the test database running?  docker start inventoryapp-db-1\n` +
        `Original error: ${(cause as Error).message}`,
    );
  }
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function setup(): Promise<void> {
  if (process.env.SKIP_TEST_DB === "1") return;

  const template = templateDbName();

  await withMaintenance(async (client) => {
    // WITH (FORCE) terminates stragglers (Postgres 13+). Dropping first means a
    // crashed previous run cannot leave poisoned state behind.
    await client.query(`DROP DATABASE IF EXISTS "${template}" WITH (FORCE)`);
    await client.query(`CREATE DATABASE "${template}"`);
  });

  // Migrate ONCE, against the template only.
  execSync("npx prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: urlFor(template) },
    stdio: "inherit",
  });

  await withMaintenance(async (client) => {
    // A loop of DDL, not of data access: CREATE DATABASE cannot be batched, and
    // each clone is a file-level copy of an already-migrated schema, so this is
    // milliseconds per worker rather than a migration each.
    for (let worker = 1; worker <= MAX_TEST_WORKERS; worker++) {
      const db = workerDbName(worker);
      await client.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
      await client.query(`CREATE DATABASE "${db}" TEMPLATE "${template}"`);
    }
  });
}

export async function teardown(): Promise<void> {
  if (process.env.SKIP_TEST_DB === "1") return;
  try {
    await withMaintenance(async (client) => {
      for (let worker = 1; worker <= MAX_TEST_WORKERS; worker++) {
        await client.query(`DROP DATABASE IF EXISTS "${workerDbName(worker)}" WITH (FORCE)`);
      }
      await client.query(`DROP DATABASE IF EXISTS "${templateDbName()}" WITH (FORCE)`);
    });
  } catch {
    // Cleanup must never fail an otherwise-green run. A killed run skips this
    // entirely; the next run's DROP-then-CREATE recovers either way.
  }
}
