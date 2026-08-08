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
//
// No `#!/usr/bin/env node` shebang: every real invocation (package.json,
// ci.yml) already runs this explicitly as `node scripts/check-security-docs.mjs`,
// and a leading shebang breaks importing this module for its WATCHED export —
// esbuild only strips a shebang for an entry point, not for a file loaded as a
// dependency, so check-security-docs.test.mjs would fail with a bare
// `SyntaxError: Invalid or unexpected token` on the very first line.

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const DOC = "docs/SECURITY.md";
const SKIP_TOKEN = "[skip security-doc]";

// Files whose behavior IS the security posture. Each entry is [regex, why] —
// the "why" is printed on failure so the message says what to go update.
//
// Exported so scripts/check-security-docs.test.mjs can assert this list
// itself still covers every security-relevant file this codebase has, without
// invoking the CLI's git/process.exit side effects — see the module-execution
// guard at the bottom of this file.
export const WATCHED = [
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
  // Covers public-access.ts (the PIN hash), -cookie.ts (the signed cookie) and
  // -guard.ts (the in-app check that gates the search action now that `/` is
  // public). The last one is the whole gate for that action, so it must not be
  // able to change quietly.
  [/^src\/lib\/public-access(-cookie|-guard)?\.ts$/, "the public PIN gate (§3)"],
  // The scoped receipt link: its signing scope, its domain separator, and the
  // fact that it does not expire ARE the posture. The grant it mints is the one
  // way into the PII surface that needs neither a session nor the PIN.
  [/^src\/lib\/receipt-link-token\.ts$/, "the scoped receipt-link bypass (§3)"],
  // The HMAC + constant-time compare behind BOTH the unlock cookie and the
  // receipt link token. A change here changes both at once.
  [/^src\/lib\/web-hmac\.ts$/, "the Web-Crypto primitives behind the PIN gate (§3)"],
  [/^src\/app\/actions\/search\.ts$/, "the public search action's own PIN check (§3)"],
  [/^src\/app\/actions\/unlock\.ts$/, "the unlock action + cookie flags, anti-guessing delay (§3)"],
  // The policy numbers (5/15min, 60/15min, 300/min), the composite key shape,
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
  [/^src\/app\/admin\/actions\/readiness\.ts$/, "the hand-settable readiness allowlist (§2)"],
  // item create/edit/delete actions — permanent delete is admin-only (§2). Was
  // deliberately UNWATCHED (the file churns for unrelated reasons); that
  // tradeoff no longer holds now that it carries deleteItemAction, an
  // irreversible admin-only write, so it joins the other action files above.
  [/^src\/app\/admin\/actions\/items\.ts$/, "item create/edit/delete actions — permanent delete is admin-only (§2)"],
  [/^src\/app\/api\/cron\//, "cron authentication (§8)"],
  [/^src\/lib\/cron-auth\.ts$/, "the shared secret check for session-less routes (§8)"],
  [/^src\/app\/api\/items\/import\/route\.ts$/, "the secret-authenticated machine import endpoint (§8)"],
  // Resolves the identity automated writes are attributed to. It THROWS
  // rather than falling back to any other account when the service account is
  // missing — docs/SECURITY.md is explicit that this must stay a loud
  // failure, not a silent substitution of "whoever we found". A change here
  // that reintroduces a fallback would widen who a machine import can be
  // attributed to without any doc noticing.
  [/^src\/modules\/items\/import-actor\.ts$/, "the automated-import service-account resolver (§8)"],
  [/^src\/lib\/email\.ts$/, "outbound email escaping (§4, §6)"],
  // Decides WHO receives every custody email -- and those messages carry party
  // names, contact details and the signed hand-receipt PDF. Adding an address
  // here silently widens who sees receipt PII, which is a disclosure change even
  // though the file reads like plumbing. The built-in default list is the point:
  // it ships addresses, so editing it changes real recipients with no config.
  [/^src\/lib\/email-recipients\.ts$/, "who is copied on custody email, and the PII that carries (§6, §9)"],
  // Holds a long-lived send credential and builds raw MIME headers. The CR/LF
  // strip in buildRawEmail is the only thing stopping caller-supplied text from
  // forging headers, and it is one deleted regex away from being gone.
  [/^src\/lib\/gmail-oauth-email\.ts$/, "outbound mail header injection guard + the OAuth send credential (§5, §6)"],
  // Already watched for the reset-token Referrer-Policy (§4); this branch adds
  // the identical control for the receipt-link token (§3) to the same file —
  // the reason is widened rather than duplicating the regex entry.
  [/^next\.config\.ts$/, "security response headers: reset-token + receipt-link-token Referrer-Policy (§3, §4)"],
  [/^\.github\/workflows\/ci\.yml$/, "the CI security gates (§11)"],
  // Not deployed code — local Windows tooling. Watched anyway because it holds a
  // Google OAuth client secret, an account-wide Vercel API token and a deploy hook
  // URL on a workstation, and because a successful run WRITES a production
  // environment variable and triggers a production deploy with no human present.
  // The DPAPI storage decision, the log-scrubbing and the "%1 is omitted from the
  // protocol handler" reasoning ARE the posture here, and all three live only in
  // these files. Directory-wide on purpose: any new file in this tool inherits the
  // same credential access.
  [/^scripts\/gmail-token-rotation\//, "workstation-held deploy credentials and unattended production writes (§6)"],
  // Drafts are the one PRIVATE, owner-scoped surface in an otherwise
  // org-shared app, and they hold party PII (names, ranks, units, phone
  // numbers, emails) with no signature. The userId scoping IS the control —
  // an unwatched change to either file could quietly turn a personal draft
  // into a shared one, or drop the scope from a query.
  [/^src\/modules\/receipts\/drafts\.service\.ts$/, "owner-scoped draft storage (§2)"],
  [/^src\/app\/actions\/drafts\.ts$/, "draft save/delete actions (§2)"],
  // The parser is what DROPS the recipient signature before anything is
  // stored. A change here could start persisting ink without touching either
  // file above.
  [/^src\/modules\/receipts\/drafts\.form\.ts$/, "keeps signatures out of stored drafts (§2)"],
  // Every hand-edit of the shared contact book is admin-only, but
  // upsertContactFromParty is written to by createReceiptAction under a bare
  // requireUser — the ONE non-admin write path into a book of outside people's
  // names, ranks, units, phone numbers and emails. The DCSIM skip, the
  // email-is-the-match-key rule and the create-only createdById are what keep
  // that widening as narrow as documented, and all three live only here.
  [/^src\/modules\/contacts\/contacts\.service\.ts$/, "the contact book's one non-admin write path (§2)"],
  // The bulk backfill of that same book. It adds no authority of its own (every
  // row goes through upsertContactFromParty), but it is a mass write of
  // PII-bearing rows that runs against whatever DATABASE_URL it is given —
  // production included. Dry-run-by-default and the redacted target banner are
  // the safety properties, and they live only in these two files.
  [/^src\/modules\/contacts\/backfill\.ts$/, "the bulk contact-book backfill (§2)"],
  [/^scripts\/backfill-contacts\.ts$/, "the backfill's dry-run-by-default guard (§2)"],
];

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

// The actual CLI. Wrapped in a function — rather than left as top-level
// module-scope code — so this file stays IMPORTABLE (for WATCHED, above)
// without shelling out to git or calling process.exit as a side effect of
// import. Only invoked below, and only when this file is the process entry
// point (`node scripts/check-security-docs.mjs`), not when another module
// imports it.
function main(base) {
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
}

// `pathToFileURL` (not a raw string compare) so this survives Windows'
// backslash argv paths and any relative/absolute mismatch between
// `import.meta.url` and `process.argv[1]`.
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main(process.argv[2] || "origin/main");
}
