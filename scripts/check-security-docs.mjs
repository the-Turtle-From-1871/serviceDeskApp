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
  // Same leaf-file reasoning as sort-keys.ts: the 10h/4h numbers, the >= at
  // both boundaries, and the backfill-from-iat rule ARE the posture, and they
  // live outside auth.ts where nothing else would notice them changing.
  [/^src\/lib\/session-freshness\.ts$/, "the session lifetime policy (§1)"],
  [/^src\/modules\/users\/users\.service\.ts$/, "deactivation revokes live tokens (§1)"],
  [/^src\/proxy\.ts$/, "the login gate and public PIN gate (§2, §3)"],
  [/^src\/lib\/password\.ts$/, "password hashing (§1)"],
  [/^src\/lib\/password-reset\.ts$/, "password-reset tokens (§4)"],
  [/^src\/lib\/reset-token\.ts$/, "reset-token generation/hashing (§4)"],
  [/^src\/app\/actions\/auth\.ts$/, "login + reset actions, anti-enumeration (§1, §4)"],
  [/^src\/lib\/public-access(-cookie)?\.ts$/, "the public PIN gate (§3)"],
  [/^src\/app\/actions\/unlock\.ts$/, "the unlock action + cookie flags, anti-guessing delay (§3)"],
  // The policy numbers (5/15min, 60/15min, 100/min), the composite key shape,
  // the spend-then-refund split and the fail-OPEN behavior are all posture, not
  // implementation detail — changing any of them changes what the app is
  // protected against.
  [/^src\/lib\/rate-limit\.ts$/, "the IP rate-limit policies and fail-open behavior (§12)"],
  // The global botnet detector: its threshold, what counts as a failure, and
  // the fact that it escalates rather than blocks are all posture.
  [/^src\/lib\/auth-velocity\.ts$/, "the distributed-attack detector and what it escalates to (§12)"],
  // The CAPTCHA gate, including the deliberate config-gate and the fail-open /
  // fail-closed split between "Cloudflare said no" and "Cloudflare is down".
  [/^src\/lib\/turnstile\.ts$/, "the Turnstile challenge and its failure posture (§13)"],
  // WHETHER the challenge is rendered at all is as security-relevant as how it
  // is verified: gating a page on the site key alone ships a widget nobody
  // checks. The widget component owns the single-use reset and the script
  // lifecycle, both of which can silently produce a tokenless form.
  [/^src\/components\/TurnstileWidget\.tsx$/, "the CAPTCHA widget lifecycle (§13)"],
  [/^src\/app\/(login|forgot-password)\/page\.tsx$/, "whether the CAPTCHA is rendered (§13)"],
  // …and whether a tokenless submission can be SENT: the forms own the state
  // that holds the submit button until the challenge answers. Deleting that
  // one `disabled` expression reintroduces the bug the third commit fixed.
  [/^src\/app\/login\/LoginForm\.tsx$/, "the submit hold on the challenge (§13)"],
  [/^src\/app\/forgot-password\/ForgotPasswordForm\.tsx$/, "the submit hold on the challenge (§13)"],
  // The reset form got the challenge last, and it is the surface where a
  // correct guess is an account takeover rather than a step towards one.
  [/^src\/app\/reset-password\/(page|ResetPasswordForm)\.tsx$/, "the CAPTCHA on the reset form (§13)"],
  [/^src\/app\/admin\/actions\/public-access\.ts$/, "setting/rotating the public PIN (§3)"],
  [/^src\/lib\/crypto\.ts$/, "the Ed25519 receipt seal (§7)"],
  // Deliberately the leaf allowlist, NOT the whole of items.service.ts: adding a
  // key here widens what may be spliced into a raw ORDER BY, which is a security
  // event, whereas the service file changes constantly for reasons that are not
  // — watching it would train people to reach for [skip security-doc] and blunt
  // the guardrail. UPDATABLE_ITEM_COLUMNS still lives in the service file and is
  // not covered; see the note in docs/SECURITY.md.
  [/^src\/modules\/items\/sort-keys\.ts$/, "the ORDER BY SQL-identifier allowlist (§2)"],
  // Same reasoning as sort-keys.ts, and the same shape: a small leaf file whose
  // job IS an allowlist. Its readiness target enum deliberately omits DEPLOYED
  // and IN_REPAIR so those two cannot be asserted by hand — widening it would
  // let a POST forge "this is issued out" / "this is in repair", which is a
  // security event even though the file reads like ordinary feature code.
  // NOTE the contrast with admin/actions/items.ts, which is NOT watched: that
  // file churns for unrelated reasons, and watching it would train people to
  // reach for [skip security-doc].
  [/^src\/app\/admin\/actions\/readiness\.ts$/, "the hand-settable readiness allowlist (§2)"],
  [/^src\/app\/api\/cron\//, "cron authentication (§8)"],
  [/^src\/lib\/cron-auth\.ts$/, "the shared secret check for session-less routes (§1)"],
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
