import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";
import { fileURLToPath } from "node:url";

const emptyModule = fileURLToPath(new URL("./tests/helpers/empty-module.ts", import.meta.url));

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
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
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "tests/**/*.test.ts"],
    fileParallelism: false, // integration tests share one test DB
    setupFiles: ["tests/helpers/setup-env.ts"],
  },
});
