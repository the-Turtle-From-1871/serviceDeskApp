# A faster vitest suite — design

**Date:** 2026-08-11
**Status:** approved, not yet implemented
**Surface:** `vitest.config.ts`, three files under `tests/helpers/`, 25 test files losing one
import and one `beforeAll` each, the `test:ui` npm script, `.github/workflows/ci.yml`, and
the docs that describe the current constraints.
**Branch:** its own, cut from `main`. Not the bulk-rename worktree.

## Problem

The suite is **332s for 161 files / 1950 tests**. Two costs dominate, both measured rather
than estimated.

### 1. It migrates 25 times instead of once

`migrateTestDb()` (`tests/helpers/db.ts:24`) shells out to `npx prisma migrate deploy` via
`execSync`, and **25 test files call it in `beforeAll`**.

A single `npx prisma migrate deploy` costs **3.5s just to start** — that timing was taken
from a run that *failed immediately* on an empty connection URL, so it is pure CLI and
config-load overhead before any database work. Against a live database it is that plus the
connection and the migration check.

**25 × ~3.5s ≈ 88s, about 26% of the runtime**, spent spawning a CLI to be told "No pending
migrations to apply." That string appears twice in the last full run's output.

### 2. 71% of the suite is serialized to protect the other 29%

```ts
fileParallelism: false, // integration tests share one test DB
```

The comment is accurate and the blast radius is far wider than intended. Of 161 test files,
**46 touch the database** (importing `@/lib/prisma` or `resetDb`) and **115 do not**. Every
pure test — the sequence builders, the readiness twins, the diff logic, the schema tests —
runs single-file because 46 others share one Postgres.

### 3. The same root cause wastes wall-clock outside the suite

Concurrent sessions on this machine share `handreceipt_test`, so one `npm test` TRUNCATEs
another mid-run. It surfaces as failures in files the running branch never touched. This has
cost real time repeatedly: a four-attempt green run on the bulk-actions branch, a
29-failure first attempt on the bulk-rename fix wave, and a standing convention in the
review process telling agents **not** to run the suite — a workflow tax that exists only
because of this.

## Non-goals

- **No test rewrites.** If a test only passes serially, that is a finding to report, not a
  thing to paper over.
- **No change to `resetDb`'s TRUNCATE safety belt.** It requires `DATABASE_URL` to contain
  `handreceipt_test`; the naming scheme below deliberately preserves that.
- **No reuse of databases between runs.** Considered: it would skip provisioning on run 2+,
  saving ~5s, and buy a stale-schema bug the first time someone adds a migration. Rejected.
- **No `SERIALIZABLE` or other isolation changes.** Out of scope.
- **No cleanup CLI.** Orphans are bounded and self-healing (below); finding strays is a
  documented one-liner, not a tool.

## Architecture

### 1. `tests/helpers/test-db-name.ts` — pure

Derives a short stable digest of the repo root path and builds the database names:

- template: `handreceipt_test_<hash>_tmpl`
- worker N: `handreceipt_test_<hash>_<n>`

No I/O, no Prisma, so it unit-tests directly. Two properties are load-bearing and each gets a
test:

- **Every name contains `handreceipt_test`**, so `resetDb`'s safety belt keeps working
  untouched. This is why the prefix is not shortened.
- **Two different checkout paths never collide**, which is what stops concurrent worktrees
  truncating each other.

### 2. `tests/helpers/global-setup.ts` — provisioning, once per run

`setup`:

1. Connect to the **`postgres` maintenance database**, derived from `DATABASE_URL`. If it is
   unreachable, fail here with a message naming `docker start inventoryapp-db-1` — rather
   than letting 46 files each produce an unrelated-looking connection error.
2. `DROP DATABASE IF EXISTS` then `CREATE` the **template**, and run `prisma migrate deploy`
   against it **once**.
3. For each worker: `CREATE DATABASE handreceipt_test_<hash>_<n> TEMPLATE handreceipt_test_<hash>_tmpl`.

**The template exists so that no test ever connects to it.** `CREATE DATABASE … TEMPLATE x`
fails while anything is attached to `x`. Cloning from worker 1's database would make that
invariant depend on timing; a dedicated template makes it structural. Postgres template
cloning is a file-level copy of an already-migrated schema, so clones 2…N cost milliseconds
instead of a migration each — the difference between ~5s of provisioning and ~32s.

`teardown` drops the checkout's databases with **`WITH (FORCE)`** (Postgres 13+, and this is
16), so a lingering connection cannot turn cleanup into a spurious failure. It swallows
errors: cleanup must never fail an otherwise-green run.

**Skipped entirely for `test:ui`.** That script runs 21 jsdom files, none of which touch the
database, and it is the tight inner loop during component work. It would otherwise pay ~5s to
build `MAX_TEST_WORKERS` databases it never opens. Gate on an env var the script sets.

### 3. `tests/helpers/setup-env.ts` — per-worker URL

One addition after the existing `dotenv` call: rewrite `DATABASE_URL` to this worker's
database from `VITEST_POOL_ID`, appending **`?connection_limit=2`**.

**It must be `VITEST_POOL_ID`, not `VITEST_WORKER_ID`** — this design originally specified
the latter and that was wrong. Verified against Vitest 4.1.9's own source: `poolId` carries
the comment *"Exposed to test runner as VITEST_POOL_ID. Value is between 1-maxWorkers"*, and
the pool seeds slots `1..maxWorkers` and releases one only when its task resolves.
`VITEST_WORKER_ID` is a **0-based, unbounded per-file counter** (`workerId++` once per test
file), so with 164 files it reaches 163 — pointing workers at databases numbered `_17`,
`_26`, … that were never provisioned. `VITEST_POOL_ID` is also set once at worker start and
never rewritten, so it is stable for the worker's lifetime, which is what `setupFiles`
needs.

**The connection cap is not a nicety — without it this fails on day one.** Prisma's default
pool is `physical_cpus × 2 + 1`, about **17 connections per client**. Eight workers is ~136
against Postgres's default `max_connections` of **100**. The suite would start dying with
connection errors whose cause looks nothing like parallelism. Tests are sequential *within* a
worker, so a pool of 2 is right, and 8 × 2 = 16 is comfortable.

### 4. `vitest.config.ts`

- Add `globalSetup`.
- **Delete `fileParallelism: false`** and the comment justifying it — the justification no
  longer holds and leaving stale reasoning is worse than leaving none.
- **Pin `pool: "forks"`.** Vitest defaults to it today, but this design newly depends on
  process-level isolation and Prisma's native bindings do not belong in worker threads. A
  load-bearing property should not rest on a default that can change in a minor release.

### 5. `tests/helpers/db.ts`

**Delete `migrateTestDb` entirely.** Once `globalSetup` owns migration, a per-file migrate is
not merely redundant — it is a footgun, because it would run against whichever worker
database happened to be current. `resetDb` and its safety belt are untouched.

### 6. The 25 test files

One import and one `beforeAll` line removed from each. Purely mechanical; the deletion is
verified by the suite still passing.

### 7. CI

The `postgres:16` service container runs as superuser, so `CREATE DATABASE` works. The
maintenance-connection derivation is **the one piece that behaves differently between local
Docker and the CI service container**, so it is verified in both before merge.

## Error handling

| Case | Behaviour |
| --- | --- |
| Postgres unreachable | `globalSetup` fails once, naming `docker start inventoryapp-db-1` |
| Template still has a connection | Cannot happen — no test is ever given the template |
| Teardown blocked by a connection | `WITH (FORCE)` terminates it; errors swallowed |
| Run killed (Ctrl-C, CI timeout) | Teardown skipped; next run's drop-and-recreate recovers |
| `globalSetup` fails partway | Partial databases; next run's drop-and-recreate recovers |
| Orphans from a retired worktree | Bounded at ~8 small schema-only DBs. Find with `SELECT datname FROM pg_database WHERE datname LIKE 'handreceipt_test_%'` |

## Verification

**A green parallel run is weak evidence.** These 46 files have only ever run serially, so one
pass could be luck. The gate is **three consecutive full-suite greens**.

**Prove the isolation rather than assume it:**
- Pure tests on `test-db-name`: hash stable across calls; different paths produce different
  names; every generated name contains `handreceipt_test`.
- One integration test asserts its own `DATABASE_URL` carries its `VITEST_POOL_ID`. Cheap,
  and it fails loudly if the rewrite ever silently stops happening — which would otherwise
  surface as inexplicable cross-talk months later.

**CI is its own gate**, because the maintenance-connection derivation differs there.

## Measurement

Three steps, so we know which change bought what:

| Stage | Time |
| --- | --- |
| Baseline | 332s (measured) |
| Fix 1 only (migrate once) | ~245s expected |
| Fix 2, 8 workers | 80.73s / 79.73s (measured, 8-core dev box) |
| Fix 2, 4 workers | 122.75s / 104.85s (measured, 8-core dev box) |

The last comparison is the point. Pure tests scale with cores, but the 46 DB files all
contend on one Postgres instance, so **eight workers may lose to four**. Ship whichever wins;
do not assume more is better. Make the worker count configurable so the comparison is a flag,
not an edit.

## Rollback

A single revert. No schema change, no migration, no product code — three helpers, one config,
25 mechanical deletions, and docs. If parallelism destabilises the suite, reverting restores
the serial behaviour exactly. **Fix 1 is independent of fix 2**, so its ~88s can be re-landed
on its own afterwards.

## Documentation, in the same commit

- **`CLAUDE.md`** — the Core Commands testing section describes the current suite and its
  constraints.
- **The rule text telling reviewers not to run the suite.** That convention exists *only*
  because of shared-database contention. Retiring it is part of the value of this change, and
  leaving it in place would tell future readers to work around a problem that no longer
  exists.
- Any rule or note asserting that agents share one test database.

## Risks

- **The DB tests have never run in parallel.** Per-worker databases should make cross-file
  interference structurally impossible — each worker owns its data, files within a worker
  stay serial, and `resetDb` still runs per test — but "should be impossible" and "verified"
  are different claims, and the first parallel run is where any hidden assumption surfaces.
- **Provisioning adds a fixed cost to every run** (~5s: one create, one migrate, seven
  near-instant clones). It is dwarfed by the ~88s saved, but it is a new floor, and it is
  paid even by a single-file `npx vitest run foo` unless the skip flag is used.
- **Database proliferation.** Up to ~8 small databases per active checkout. Five worktrees
  running suites means ~40. They are schema-only clones, and each run drops and recreates its
  own, but the disk is not free.
- **Windows/Docker specifics.** The maintenance connection and `WITH (FORCE)` are both
  exercised locally before CI, since this repo runs Postgres in Docker on Windows.
