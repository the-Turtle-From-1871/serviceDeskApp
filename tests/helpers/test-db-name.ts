import { createHash } from "node:crypto";

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
 *  so more is not automatically faster. */
export const MAX_TEST_WORKERS = Number(process.env.VITEST_MAX_WORKERS ?? 8);

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
