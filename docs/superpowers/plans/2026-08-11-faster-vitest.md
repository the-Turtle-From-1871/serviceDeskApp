# Faster Vitest Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the 332s test suite by migrating once instead of 25 times and by giving every vitest worker its own database, so 115 pure files stop queuing behind 46 database ones — and concurrent worktrees stop truncating each other.

**Architecture:** A `globalSetup` provisions one migrated template database per checkout and clones it per worker via Postgres `CREATE DATABASE … TEMPLATE`; `setup-env.ts` points each worker at its own clone. `migrateTestDb` and `fileParallelism: false` are then deleted.

**Tech Stack:** Vitest 4, Prisma 7, PostgreSQL 16 (Docker locally, service container in CI), `pg` (already a dependency), `dotenv` (already a dependency).

**Spec:** `docs/superpowers/specs/2026-08-11-faster-vitest-design.md`

## Global Constraints

- **`resetDb()`'s safety belt is untouched.** It refuses to TRUNCATE unless `DATABASE_URL` contains `handreceipt_test`; every generated database name must keep that substring. Never shorten the prefix.
- **Database names are SQL identifiers, which cannot be parameterised.** They are built from a hash of the repo path, never from user input, and `test-db-name.ts` asserts `^[a-z0-9_]+$` before any name reaches a query. That assertion is the injection guard — do not remove it.
- **`connection_limit=2` on every worker URL.** Prisma's default pool is `physical_cpus × 2 + 1` (~17); 8 workers would be ~136 against Postgres's default `max_connections` of 100.
- **No test rewrites.** If a test only passes serially, report it — do not paper over it.
- **`npm run build` fails in a worktree** (Turbopack rejects parent-walked `node_modules`) unless `turbopack.root` is set. Known artifact, not part of this work.
- Tests sit beside their subject. Docs ship in the same commit as the code.
- **Each task must leave the suite green.** The ordering below guarantees that; do not reorder.

---

## File Structure

**Create:**
- `tests/helpers/test-db-name.ts` — pure name derivation. No I/O, no Prisma.
- `tests/helpers/test-db-name.test.ts` — pure tests.
- `tests/helpers/global-setup.ts` — provisioning and teardown.

**Modify:**
- `tests/helpers/setup-env.ts` — rewrite `DATABASE_URL` per worker.
- `tests/helpers/db.ts` — delete `migrateTestDb`.
- `vitest.config.ts` — add `globalSetup`, pin `pool`, delete `fileParallelism`.
- `package.json` — `cross-env` devDependency; `test:ui` and `test:ui:watch` skip provisioning.
- **25 test files** — remove the `migrateTestDb` import and its `beforeAll`.
- `CLAUDE.md`, and the rule text telling reviewers not to run the suite.

---

### Task 1: Pure database-name derivation

**Files:**
- Create: `tests/helpers/test-db-name.ts`
- Create: `tests/helpers/test-db-name.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `MAX_TEST_WORKERS: number`; `templateDbName(root?: string): string`; `workerDbName(worker: number, root?: string): string`.

- [ ] **Step 1: Write the failing test**

Create `tests/helpers/test-db-name.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { templateDbName, workerDbName, MAX_TEST_WORKERS } from "./test-db-name";

const A = "/c/inventoryApp";
const B = "/c/inventoryApp/.claude/worktrees/bulk-rename";

describe("test database names", () => {
  it("always contains handreceipt_test, so resetDb's safety belt still matches", () => {
    // resetDb() refuses to TRUNCATE unless DATABASE_URL contains this substring.
    // Shortening the prefix would silently disable the guard.
    expect(templateDbName(A)).toContain("handreceipt_test");
    for (let i = 1; i <= MAX_TEST_WORKERS; i++) {
      expect(workerDbName(i, A)).toContain("handreceipt_test");
    }
  });

  it("is stable for the same path", () => {
    expect(workerDbName(1, A)).toBe(workerDbName(1, A));
    expect(templateDbName(A)).toBe(templateDbName(A));
  });

  it("differs between checkouts, so concurrent worktrees cannot collide", () => {
    expect(workerDbName(1, A)).not.toBe(workerDbName(1, B));
    expect(templateDbName(A)).not.toBe(templateDbName(B));
  });

  it("differs between workers within a checkout", () => {
    expect(workerDbName(1, A)).not.toBe(workerDbName(2, A));
  });

  it("never collides with the template", () => {
    for (let i = 1; i <= MAX_TEST_WORKERS; i++) {
      expect(workerDbName(i, A)).not.toBe(templateDbName(A));
    }
  });

  it("ignores path case, so Windows drive-letter casing does not fork the name", () => {
    expect(workerDbName(1, "/C/InventoryApp")).toBe(workerDbName(1, "/c/inventoryapp"));
  });

  it("emits only characters safe to splice into a DDL identifier", () => {
    // Database names cannot be parameterised, so this charset assertion IS the
    // injection guard.
    for (const n of [templateDbName(B), workerDbName(3, B)]) {
      expect(n).toMatch(/^[a-z0-9_]+$/);
    }
  });

  it("stays inside Postgres's 63-byte identifier limit", () => {
    expect(templateDbName(B).length).toBeLessThan(63);
    expect(workerDbName(MAX_TEST_WORKERS, B).length).toBeLessThan(63);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test-db-name`
Expected: FAIL — `Failed to resolve import "./test-db-name"`.

- [ ] **Step 3: Write the module**

Create `tests/helpers/test-db-name.ts`:

```ts
import { createHash } from "node:crypto";
import { cpus } from "node:os";

// Pure derivation of the per-checkout, per-worker test database names. No I/O
// and no Prisma, so it unit-tests directly.
//
// WHY PER CHECKOUT: every worktree on this machine used to share one
// `handreceipt_test`, so two sessions running `npm test` TRUNCATEd each other
// mid-run. That surfaces as failures in files the running branch never touched
// — see the shared-test-DB notes in the repo docs. Hashing the repo root gives
// each checkout its own set.

/** Worker slots to provision. Override with VITEST_MAX_WORKERS when measuring
 *  whether fewer workers beat more — the DB tests all contend on one Postgres,
 *  so more is not automatically faster. Floors at 1: `??` alone would let
 *  `VITEST_MAX_WORKERS=""` or `cpus()` returning `[]` resolve to 0, which
 *  Vitest's own maxWorkers option silently discards (falling back to its
 *  core-derived default) rather than erroring — running a full worker set
 *  against zero provisioned databases. */
export const MAX_TEST_WORKERS = Math.max(1, Number(process.env.VITEST_MAX_WORKERS || Math.min(8, cpus().length)) || 1);

/** Load-bearing: `resetDb()` refuses to TRUNCATE unless DATABASE_URL contains
 *  this exact substring. Every name below keeps it. */
const PREFIX = "handreceipt_test";

function repoHash(root: string): string {
  // Lowercased because Windows reports drive letters inconsistently and two
  // spellings of one path must not produce two sets of databases.
  return createHash("sha256").update(root.toLowerCase()).digest("hex").slice(0, 8);
}

/** A database name is a SQL IDENTIFIER and cannot be bound as a parameter, so
 *  it is spliced into DDL. These names come from a hash, never from user input
 *  — this assertion is what keeps that true if someone changes the derivation. */
function assertSafe(name: string): string {
  if (!/^[a-z0-9_]+$/.test(name)) {
    throw new Error(`Refusing to use an unsafe database name: ${name}`);
  }
  return name;
}

/** The migrated database that worker databases are cloned from. NO test ever
 *  connects to it — `CREATE DATABASE … TEMPLATE x` fails while anything is
 *  attached to `x`, and a dedicated template makes that structural rather than
 *  a matter of timing. */
export function templateDbName(root: string = process.cwd()): string {
  return assertSafe(`${PREFIX}_${repoHash(root)}_tmpl`);
}

export function workerDbName(worker: number, root: string = process.cwd()): string {
  return assertSafe(`${PREFIX}_${repoHash(root)}_${worker}`);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test-db-name`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add tests/helpers/test-db-name.ts tests/helpers/test-db-name.test.ts
git commit -m "test: derive per-checkout, per-worker database names"
```

---

### Task 2: Provision the databases in `globalSetup`

The suite still uses the shared database after this task — nothing points at the new ones yet. That is deliberate: it lets provisioning be verified on its own, with the suite green throughout.

**Files:**
- Create: `tests/helpers/global-setup.ts`
- Modify: `vitest.config.ts`

**Interfaces:**
- Consumes: `MAX_TEST_WORKERS`, `templateDbName`, `workerDbName` (Task 1).
- Produces: `setup()` and `teardown()` exports consumed by Vitest's `globalSetup`; the env flag `SKIP_TEST_DB=1` which short-circuits both.

- [ ] **Step 1: Write the setup module**

Create `tests/helpers/global-setup.ts`:

```ts
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
```

- [ ] **Step 2: Wire it into the config**

In `vitest.config.ts`, inside `test: { … }`, add below `setupFiles`:

```ts
    // Provisions the per-worker databases once per run. See global-setup.ts.
    globalSetup: ["tests/helpers/global-setup.ts"],
```

Leave `fileParallelism: false` in place for now — Task 4 removes it.

- [ ] **Step 3: Verify the databases are created and dropped**

Run a single cheap file so provisioning runs without a long suite:

```bash
npx vitest run test-db-name
```

While it runs it is hard to observe, so verify by inspection afterwards — the teardown should have removed everything:

```bash
docker exec inventoryapp-db-1 psql -U postgres -c \
  "SELECT datname FROM pg_database WHERE datname LIKE 'handreceipt_test_%'"
```

Expected: no rows — setup created 9 databases and teardown dropped them all.

**Note `$DATABASE_URL` is NOT set in your shell** — it lives in `.env.test` and is loaded by `setup-env.ts` inside the vitest process, so a bare `psql "$DATABASE_URL"` would connect to nothing. Going through the container avoids needing a local `psql` at all.

To watch provisioning actually happen, run that query in a second terminal *while* a longer suite is running — the databases exist only between setup and teardown.

- [ ] **Step 4: Verify the friendly error**

Stop the container, run the same command, and confirm the message names `docker start inventoryapp-db-1` rather than surfacing a raw connection error:

```bash
docker stop inventoryapp-db-1
npx vitest run test-db-name
docker start inventoryapp-db-1
```

- [ ] **Step 5: Confirm the suite is still green**

Run: `npm test`
Expected: 161 files pass. Still ~332s — nothing has been sped up yet; this only proves provisioning does not break anything.

- [ ] **Step 6: Commit**

```bash
git add tests/helpers/global-setup.ts vitest.config.ts
git commit -m "test: provision per-worker databases from one migrated template"
```

---

### Task 3: Point each worker at its own database, and delete `migrateTestDb`

Still serial after this task. The win here is fix 1 — one migration instead of 25.

**Files:**
- Modify: `tests/helpers/setup-env.ts`
- Modify: `tests/helpers/db.ts`
- Modify: 25 test files

**Interfaces:**
- Consumes: `workerDbName` (Task 1); the databases provisioned by Task 2.
- Produces: a `DATABASE_URL` per worker carrying `connection_limit=2`. `migrateTestDb` no longer exists.

- [ ] **Step 1: Rewrite the URL per worker**

In `tests/helpers/setup-env.ts`, add after the existing `config({ … })` call:

```ts
import { workerDbName } from "./test-db-name";

// Point this worker at its own database (provisioned in global-setup.ts).
// Without this, parallel files TRUNCATE each other through resetDb().
if (process.env.SKIP_TEST_DB !== "1" && process.env.DATABASE_URL) {
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${workerDbName(Number(process.env.VITEST_POOL_ID || 1))}`;
  // Prisma's default pool is physical_cpus*2+1 (~17 here). Eight workers would
  // open ~136 connections against Postgres's default max_connections of 100 and
  // the suite would die with errors that look nothing like their cause. Tests
  // are sequential WITHIN a worker, so two is plenty.
  url.searchParams.set("connection_limit", "2");
  process.env.DATABASE_URL = url.toString();
}
```

- [ ] **Step 2: Add the test that pins the wiring**

Append to `tests/helpers/test-db-name.test.ts`:

```ts
it("the running worker is pointed at its own database", () => {
  // Cheap, and it fails loudly if the rewrite in setup-env.ts ever silently
  // stops happening — which would otherwise surface as inexplicable cross-talk
  // between files months from now.
  const worker = Number(process.env.VITEST_POOL_ID || 1);
  expect(process.env.DATABASE_URL).toContain(workerDbName(worker));
  expect(process.env.DATABASE_URL).toContain("connection_limit=2");
});
```

- [ ] **Step 3: Run it**

Run: `npx vitest run test-db-name`
Expected: PASS, 9 tests.

- [ ] **Step 4: Delete `migrateTestDb`**

In `tests/helpers/db.ts`, delete the entire `migrateTestDb` function and its `import { execSync } from "node:child_process";` if nothing else uses it. Leave `resetDb` and its safety belt exactly as they are.

Then remove the import and the call from all 25 test files. Find them with:

```bash
grep -rl "migrateTestDb" src tests --include=*.test.ts --include=*.test.tsx
```

In each: drop `migrateTestDb` from the `import { … } from ".../tests/helpers/db"` line (keeping `resetDb`), and delete its `beforeAll` — which appears as either `beforeAll(() => migrateTestDb());` or `beforeAll(migrateTestDb);` or a bare `migrateTestDb();` inside a `beforeAll` that does other work too. **Where the `beforeAll` does other work, remove only the `migrateTestDb()` line, not the block.**

- [ ] **Step 5: Confirm the suite is green and measure**

Run: `npm test`
Expected: 161 files pass. **Record the duration** — the spec predicts ~245s against a 332s baseline. Report the real number.

- [ ] **Step 6: Commit**

```bash
git add tests/helpers/setup-env.ts tests/helpers/db.ts tests/helpers/test-db-name.test.ts src tests
git commit -m "test: migrate once per run instead of once per file"
```

---

### Task 4: Turn parallelism on

**Files:**
- Modify: `vitest.config.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: everything from Tasks 1-3.
- Produces: a parallel suite; `test:ui` and `test:ui:watch` that skip provisioning.

- [ ] **Step 1: Add `cross-env`**

`test:ui` runs 21 jsdom files that touch no database, and it is the tight loop during component work — it should not pay ~5s to build `MAX_TEST_WORKERS` databases it never opens. Setting an env var inline is not portable on Windows, and `cross-env` is not yet a dependency.

Validate it exists before installing (repo rule — never install an unverified package):

```bash
npm view cross-env version
npm install --save-dev cross-env
```

- [ ] **Step 2: Skip provisioning for the UI scripts**

In `package.json`:

```json
    "test:ui": "cross-env SKIP_TEST_DB=1 vitest run .test.tsx",
    "test:ui:watch": "cross-env SKIP_TEST_DB=1 vitest .test.tsx",
```

- [ ] **Step 3: Enable parallelism**

In `vitest.config.ts`, **delete** this line and its comment:

```ts
    fileParallelism: false, // integration tests share one test DB
```

and add:

```ts
    // Pinned rather than left to the default: this suite now depends on
    // process-level isolation for its per-worker databases, and Prisma's native
    // bindings do not belong in worker threads.
    pool: "forks",
    // MUST NOT exceed MAX_TEST_WORKERS. globalSetup provisions exactly that many
    // databases, so a worker numbered beyond it would resolve to a database
    // nobody created and fail to connect. Vitest's default is derived from the
    // core count, so on a bigger machine it would silently overrun.
    maxWorkers: MAX_TEST_WORKERS,
```

with the import at the top of the file:

```ts
import { MAX_TEST_WORKERS } from "./tests/helpers/test-db-name";
```

**Why this is not optional:** `globalSetup` creates databases 1…`MAX_TEST_WORKERS`. If Vitest ever spawns worker `MAX_TEST_WORKERS + 1` — which its core-derived default would do on a 16-core machine — that worker's `DATABASE_URL` names a database that was never created, and every test in it fails to connect. Deriving both numbers from one constant makes the mismatch unrepresentable.

- [ ] **Step 4: Verify `test:ui` skips provisioning**

Run: `npm run test:ui`
Expected: 22 files pass, and **no** `handreceipt_test_*` databases are created — confirm with the `pg_database` query from Task 2 while it runs, or simply confirm the run does not print prisma's migrate output.

- [ ] **Step 5: THREE consecutive green full runs**

These 46 database files have never run in parallel. One green run could be luck; the gate is three.

```bash
npm test && npm test && npm test
```

Expected: 161 files pass, three times. **Record each duration.**

If a file fails, **do not fix the test.** Report which file, whether it fails in isolation (`npx vitest run <file>`), and whether it fails consistently — a test that only passes serially is a finding about that test, and the plan says so explicitly.

- [ ] **Step 6: Commit**

```bash
git add vitest.config.ts package.json package-lock.json
git commit -m "test: run test files in parallel, each worker on its own database"
```

---

### Task 5: Measure the worker count, and correct the docs

**Files:**
- Modify: `CLAUDE.md`
- Modify: the rule file telling reviewers not to run the suite

- [ ] **Step 1: Measure 4 workers against 8**

The pure files scale with cores, but all 46 database files contend on one Postgres instance, so more workers is not automatically faster.

```bash
VITEST_MAX_WORKERS=4 npx vitest run --maxWorkers=4
VITEST_MAX_WORKERS=8 npx vitest run --maxWorkers=8
```

Record both. If 4 wins, set `maxWorkers: 4` in `vitest.config.ts` with a comment giving both numbers; if 8 wins, leave the default and record the comparison in the commit message. **Report the numbers either way** — the point is to decide from data rather than assume.

- [ ] **Step 2: Correct `CLAUDE.md`**

Its Core Commands section describes the suite. Update the runtime, and state that each worker now has its own database so concurrent runs no longer interfere.

- [ ] **Step 3: Retire the do-not-run-the-suite convention**

Find it with:

```bash
grep -rn "do not run the suite\|must not run the suite\|reviewers must not" .claude CLAUDE.md docs
```

That convention exists **only** because of shared-database contention. Now that each worker and each checkout has its own database, it is obsolete — and leaving it in place would tell future readers to work around a problem that no longer exists. Replace it with a note that concurrent runs are safe, and why.

- [ ] **Step 4: Verify in CI — this is a separate gate, not a formality**

Push the branch and open a PR. The maintenance-connection derivation is **the one piece that behaves differently between local Docker and CI**: locally Postgres is on `localhost:5435` in a container you can name, while CI is a `postgres:16` service container on `localhost:5432` whose `.env.test` the workflow writes inline. Both resolve to `urlFor("postgres")`, but that has only ever been exercised locally.

Confirm the `Tests (vitest)` job goes green, and note its duration against the previous run's — CI is a clean checkout with no sibling worktrees, so it is the least noisy measurement available.

If it fails on the maintenance connection, the likely cause is the CI Postgres refusing a connection to the `postgres` database under those credentials; report it rather than working around it.

- [ ] **Step 5: Final full run and commit**

```bash
npm test
git add CLAUDE.md .claude vitest.config.ts
git commit -m "docs: concurrent test runs no longer interfere"
```
