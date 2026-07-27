#!/usr/bin/env node
// Guardrail: security-relevant code must not change without docs/SECURITY.md
// changing in the same set of commits.
//
// Rationale: docs/SECURITY.md is the living inventory of the app's security
// controls. A convention in CLAUDE.md is not enforcement — this is. It runs in
// CI on every PR to main (see .github/workflows/ci.yml) and can be run locally:
//
//   node scripts/check-security-docs.mjs [baseRef]      # default: origin/main
//
// Escape hatch: put [skip security-doc] in any commit message in the range when
// a change genuinely touches these files without altering the security posture
// (a rename, a comment, a mechanical refactor). The check then passes and says
// so loudly, which leaves a reviewable trail rather than a silent bypass.

import { execFileSync } from "node:child_process";

const DOC = "docs/SECURITY.md";
const SKIP_TOKEN = "[skip security-doc]";

// Files whose behavior IS the security posture. Each entry is [regex, why] —
// the "why" is printed on failure so the message says what to go update.
const WATCHED = [
  [/^src\/lib\/authz\.ts$/, "authorization checks (§2)"],
  [/^src\/auth\.ts$/, "authentication + session revocation (§1)"],
  [/^src\/proxy\.ts$/, "the login gate and public PIN gate (§2, §3)"],
  [/^src\/lib\/password\.ts$/, "password hashing (§1)"],
  [/^src\/lib\/password-reset\.ts$/, "password-reset tokens (§4)"],
  [/^src\/lib\/reset-token\.ts$/, "reset-token generation/hashing (§4)"],
  [/^src\/app\/actions\/auth\.ts$/, "login + reset actions, anti-enumeration (§1, §4)"],
  [/^src\/lib\/public-access(-cookie)?\.ts$/, "the public PIN gate (§3)"],
  [/^src\/lib\/crypto\.ts$/, "the Ed25519 receipt seal (§7)"],
  [/^src\/app\/api\/cron\//, "cron authentication (§8)"],
  [/^src\/lib\/email\.ts$/, "outbound email escaping (§4, §6)"],
  [/^next\.config\.ts$/, "security response headers (§4)"],
  [/^\.github\/workflows\/ci\.yml$/, "the CI security gates (§11)"],
];

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

const base = process.argv[2] || "origin/main";

// Merge-base diff ("...") so we only judge what this branch changed, not what
// main moved on to underneath it.
let changed;
try {
  changed = git(["diff", "--name-only", `${base}...HEAD`]).split("\n").filter(Boolean);
} catch {
  console.error(`[security-docs] cannot diff against "${base}" — is it fetched?`);
  process.exit(2); // config problem, not a policy violation
}

const triggers = changed.flatMap((file) => {
  const hit = WATCHED.find(([re]) => re.test(file));
  return hit ? [{ file, why: hit[1] }] : [];
});

if (triggers.length === 0) {
  console.log("[security-docs] no security-relevant files changed — nothing to check.");
  process.exit(0);
}

if (changed.includes(DOC)) {
  console.log(`[security-docs] OK — ${triggers.length} security-relevant file(s) changed and ${DOC} was updated.`);
  process.exit(0);
}

const messages = git(["log", "--format=%B", `${base}...HEAD`]);
if (messages.includes(SKIP_TOKEN)) {
  console.log(`[security-docs] BYPASSED via "${SKIP_TOKEN}".`);
  console.log("  Changed without a doc update:");
  for (const t of triggers) console.log(`    ${t.file}`);
  console.log("  Confirm in review that the security posture genuinely did not change.");
  process.exit(0);
}

console.error(`\n[security-docs] FAILED — security-relevant code changed but ${DOC} did not.\n`);
for (const t of triggers) console.error(`  ${t.file}\n      covers ${t.why}`);
console.error(`
Update ${DOC}:
  - edit the entry for each control that changed (or delete it, if the control
    was removed — a doc describing controls that no longer exist is worse than
    no doc);
  - add to "Known gaps & accepted risks" if this introduces or resolves one;
  - bump the "Last reviewed" date at the top.

If this change genuinely does not alter the security posture (a rename, a
comment, a mechanical refactor), add "${SKIP_TOKEN}" to a commit message.
`);
process.exit(1);
