import { execSync } from "node:child_process";
import { Client } from "pg";
import { config } from "dotenv";
import { MAX_TEST_WORKERS, checkoutDbPrefix, templateDbName, workerDbName } from "./test-db-name";

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

  // Ahead of withMaintenance's connect()-failure wrapper below on purpose: on
  // a fresh clone .env.test doesn't exist yet (it's gitignored, per-clone), so
  // DATABASE_URL is unset and `new URL("")` throws a bare
  // `TypeError [ERR_INVALID_URL]` with no mention of .env.test — exactly the
  // "error that looks unrelated to its cause" withMaintenance exists to
  // prevent, just one step earlier than it can catch.
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is not set — .env.test is missing or empty.\n" +
        "Create it: copy .env.example to .env.test (or copy .env.test from the main clone) " +
        "and fill in a DATABASE_URL pointing at your local Postgres.",
    );
  }

  const template = templateDbName();

  await withMaintenance(async (client) => {
    // WITH (FORCE) terminates stragglers (Postgres 13+). Dropping first means a
    // crashed previous run cannot leave poisoned state behind.
    await client.query(`DROP DATABASE IF EXISTS "${template}" WITH (FORCE)`);
    await client.query(`CREATE DATABASE "${template}"`);
  });

  // Migrate ONCE, against the template only.
  //
  // Both DATABASE_URL and DIRECT_URL must be overridden: prisma.config.ts
  // resolves the migration datasource as `DIRECT_URL ?? DATABASE_URL`, and
  // CI's .env.test sets both. Overriding DATABASE_URL alone left DIRECT_URL
  // still naming the plain `handreceipt_test` database, so `migrate deploy`
  // silently migrated THAT instead of the template — the template and every
  // clone stayed empty, and every worker connected to an empty database.
  // Locally this was invisible because this worktree's .env.test sets no
  // DIRECT_URL, so the `??` fallback landed on DATABASE_URL either way.
  execSync("npx prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: urlFor(template), DIRECT_URL: urlFor(template) },
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
      // Drop by PATTERN, not by iterating 1..MAX_TEST_WORKERS: a run at 8
      // workers followed by a run at 4 (which now happens automatically on
      // any host with fewer than 8 cores, and happened during this branch's
      // own measurement) never revisits slots 5-8, so they'd be orphaned
      // forever under the old index loop. `checkoutDbPrefix()` is scoped to
      // this checkout's hash, and the query is further scoped to `pg_database`
      // rows actually matching it — so this can never touch another
      // checkout's databases, the shared `handreceipt_test`, or the
      // pre-existing `handreceipt_test_units`.
      const prefix = checkoutDbPrefix();
      const { rows } = await client.query<{ datname: string }>(
        `SELECT datname FROM pg_database WHERE datname LIKE $1`,
        [`${prefix}%`],
      );
      for (const { datname } of rows) {
        // Defense in depth: datname came back from Postgres itself (already
        // constrained by the LIKE above), but it's about to be spliced into
        // DDL, so re-check the same shape assertSafe() enforces elsewhere.
        if (!datname.startsWith(prefix) || !/^[a-z0-9_]+$/.test(datname)) continue;
        await client.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
      }
    });
  } catch {
    // Cleanup must never fail an otherwise-green run. A killed run skips this
    // entirely; the next run's DROP-then-CREATE recovers either way.
  }
}
