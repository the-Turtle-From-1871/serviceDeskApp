import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next, but GLOBBED AT ANY DEPTH. The
    // stock `.next/**` is anchored to the config's own directory, so it misses
    // build output produced anywhere below it — and this repo has agent git
    // worktrees under `.claude/worktrees/<name>`, each of which grows its own
    // `.next`. One `npm run dev` in a worktree put ~24,500 problems (1,335 of
    // them errors) from compiled, minified output into `npm run lint`, which
    // buries every real finding. CI does not run lint, so nothing else catches
    // this.
    "**/.next/**",
    "**/out/**",
    "**/build/**",
    "**/next-env.d.ts",
    // Belt and braces: a worktree is a SEPARATE CHECKOUT of this repo. Its
    // sources are linted on their own branch, by whoever is working there —
    // linting them from here reports the same files twice and, mid-edit, from
    // a state nobody has finished writing.
    ".claude/worktrees/**",
  ]),
]);

export default eslintConfig;
