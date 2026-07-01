import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    fileParallelism: false, // integration tests share one test DB
    setupFiles: ["tests/helpers/setup-env.ts"],
  },
});
