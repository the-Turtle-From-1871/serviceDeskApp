import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { MAX_TEST_WORKERS } from "./tests/helpers/test-db-name";

const emptyModule = fileURLToPath(new URL("./tests/helpers/empty-module.ts", import.meta.url));

export default defineConfig({
  resolve: {
    // Resolves the `@/*` paths from tsconfig.json. This is Vite's native
    // replacement for the `vite-tsconfig-paths` plugin, which warned on every
    // run once Vite shipped the built-in (available from Vite 8, which is what
    // this repo installs). If a `@/...` import ever fails to resolve in a test,
    // check this flag before suspecting the import.
    tsconfigPaths: true,
    // `server-only`/`client-only` throw when imported in a plain Node env;
    // stub them so tests can import the underlying server modules directly.
    alias: { "server-only": emptyModule, "client-only": emptyModule },
  },
  test: {
    // Node stays the DEFAULT so the DB-backed service tests keep their fast
    // environment. A component test opts in per-file with a
    // `// @vitest-environment jsdom` comment on its first line — see
    // src/app/admin/users/ContactBookSection.test.tsx. (Vitest 4 removed
    // environmentMatchGlobs; the per-file docblock is the current mechanism.)
    environment: "node",
    // .tsx is matched so components can be rendered under jsdom. Before this,
    // NOTHING in this repo could render a component, and a green suite was zero
    // evidence for any UI change — a form bug that saved one contact's phone
    // number onto the next one survived all 338 tests and seven code reviews.
    // scripts/**/*.test.mjs covers the repo's own tooling scripts — plain Node,
    // not app code, so they stay .mjs rather than joining the src/ TypeScript
    // tree. The glob currently matches nothing (the security-docs guardrail it
    // was added for was retired); it stays so a new script test is picked up
    // without anyone having to remember this file.
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "tests/**/*.test.ts", "scripts/**/*.test.mjs"],
    // Pinned rather than left to the default: this suite now depends on
    // process-level isolation for its per-worker databases, and Prisma's native
    // bindings do not belong in worker threads.
    pool: "forks",
    // MUST NOT exceed MAX_TEST_WORKERS. globalSetup provisions exactly that many
    // databases, so a worker numbered beyond it would resolve to a database
    // nobody created and fail to connect. Vitest's default is derived from the
    // core count, so on a bigger machine it would silently overrun.
    maxWorkers: MAX_TEST_WORKERS,
    // Vitest's 5s default assumed serial execution — one file, one core, no
    // queue. Under real parallelism a CPU-bound test's wall clock includes
    // time spent WAITING for a core, not just doing work, so a test that was
    // never slow can blow the old budget purely because seven siblings are
    // also running bcryptjs (COST=12, pure JS) or a 501-row batch at the same
    // moment. Two different tests hit exactly this (users.service.test.ts,
    // backfill.test.ts) before this was raised. A global bump is deliberate
    // over per-test annotations: picking them off one at a time only defers
    // the next one to whichever test is unlucky enough to land on a busy
    // worker next.
    testTimeout: 30_000,
    setupFiles: ["tests/helpers/setup-env.ts"],
    // Provisions the per-worker databases once per run. See global-setup.ts.
    globalSetup: ["tests/helpers/global-setup.ts"],
  },
});
