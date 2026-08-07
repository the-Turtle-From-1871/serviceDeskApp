import { config } from "dotenv";

config({ path: ".env.test", override: true, quiet: true });

// jest-dom's matchers (toBeInTheDocument, toBeVisible, …) need a DOM, and this
// setup file runs for EVERY test file — the great majority of which are
// node-environment service tests that have no `document`. Registering them
// behind that check keeps the node suite untouched while making them available
// to any file that opts into jsdom with a `// @vitest-environment jsdom`
// docblock. Without this the dependency is installed but unreachable.
if (typeof document !== "undefined") {
  await import("@testing-library/jest-dom/vitest");
}
