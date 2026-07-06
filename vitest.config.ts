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
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    fileParallelism: false, // integration tests share one test DB
    setupFiles: ["tests/helpers/setup-env.ts"],
  },
});
