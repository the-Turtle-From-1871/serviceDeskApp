import { createHash } from "node:crypto";
import { cpus } from "node:os";

// Pure derivation of the per-checkout, per-worker test database names. No I/O
// and no Prisma (os.cpus() reads a static kernel table, not a device — no
// weaker a purity guarantee than the process.env read below it), so it
// unit-tests directly.
//
// WHY PER CHECKOUT: every worktree on this machine used to share one
// `handreceipt_test`, so two sessions running `npm test` TRUNCATEd each other
// mid-run. That surfaces as failures in files the running branch never touched
// — see the shared-test-DB notes in the repo docs. Hashing the repo root gives
// each checkout its own set.

/** Worker slots to provision. Defaults to the smaller of 8 and the machine's
 *  own core count, NOT a bare 8: 8 was measured as the winner on the 8-core
 *  local dev box (4-vs-8, ~80s vs ~105-123s), but GitHub-hosted CI runners
 *  typically have far fewer cores. Oversubscribing forks there doesn't just
 *  slow things down — it makes CPU-bound tests (bcryptjs hashing at COST=12
 *  in changeUserPassword) blow their wall-clock timeout for reasons that have
 *  nothing to do with the test, which is what actually happened in CI.
 *  Override with VITEST_MAX_WORKERS when measuring whether fewer workers beat
 *  more — the DB tests all contend on one Postgres, so more is not
 *  automatically faster even when cores allow it. */
// `|| ... || 1`, not `??`: Vitest's own `resolveMaxWorkers` uses a truthiness
// check, so `maxWorkers: 0` is silently DISCARDED and Vitest falls back to its
// own core-derived count — the result isn't a hang, it's a full worker set
// running against zero provisioned databases, exactly the failure bcf5205
// exists to make unrepresentable. Two ways to reach 0 here: `cpus()` returning
// `[]` (rare, containerised hosts — Vitest itself uses `availableParallelism()`,
// which is never 0, so the two can disagree in the dangerous direction), and
// `VITEST_MAX_WORKERS=""`, which `??` does NOT catch (`Number("") === 0`) and
// which the docs advertise as the override lever. Same trap, same fix, as
// `setup-env.ts`'s `VITEST_POOL_ID` fallback (see its comment) — guarded there
// and, until now, not here.
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

/** The LIKE-pattern-safe prefix shared by every database (template + every
 *  worker) belonging to THIS checkout. `teardown()` drops by this pattern
 *  rather than by iterating `1..MAX_TEST_WORKERS`, so a run whose worker
 *  count shrinks between invocations (8 locally, then 4 on a smaller host —
 *  see MAX_TEST_WORKERS above) doesn't leave the slots it no longer visits
 *  orphaned. Scoped to this checkout's hash, so the pattern can never match
 *  another checkout's databases, the shared `handreceipt_test`, or the
 *  pre-existing `handreceipt_test_units`. */
export function checkoutDbPrefix(root: string = process.cwd()): string {
  return assertSafe(`${PREFIX}_${repoHash(root)}_`);
}
