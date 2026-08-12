// Coverage check for the read-only demo account.
//
// Every Server Action that WRITES must call `denyReadOnly(user)` from
// `@/lib/authz`. This test reads the source of every non-test file in
// `src/app/actions` and `src/app/admin/actions`, splits each file at its
// exported function boundaries so one guard cannot vouch for the function
// next to it, and fails when an exported action's own body has no call.
//
// WHY THE ALLOWLIST LIVES HERE, AND NOT AS AN ANNOTATION IN THE ACTION.
// Exempting an action is a deliberate edit to THIS file, so the exemption
// shows up in the diff of the pull request that introduces it, on a line a
// reviewer has to read and approve. A `// read-only-safe` comment sitting in
// the action file would travel with the code it excuses: whoever later turns
// that read into a write inherits the exemption silently, and the diff that
// made it a write shows no sign the guard was ever waived. The reason string
// is part of the point — it records what was verified, not merely that
// somebody waived it.
//
// THIS CHECK IS ADVISORY IN CI. Only `Semgrep SAST` and `Build (next build)`
// are required checks on `main` in this repo; the Vitest job is not, so a red
// result here does NOT block a merge. It reports a forgotten guard to whoever
// reads the job output — it cannot prevent one from shipping. Treat a failure
// as a real missing guard until proven otherwise, because nothing downstream
// will catch it.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const ACTION_DIRS = [
  path.join(__dirname),
  path.join(__dirname, "..", "admin", "actions"),
];

// Action name -> why it is exempt. Verified reads and unauthenticated paths
// only. If a run flags an action that genuinely writes, the fix is the guard,
// never a new line here.
const ALLOWLIST: Record<string, string> = {
  searchContactsAction: "contact type-ahead",
  revealAuditSignatureAction: "returns one stored signature",
  revealOwnSignatureAction: "returns the caller's own signature",
  lookupScannedItem: "scan lookup",
  lookupScannedSerial: "scan lookup",
  resolveScannedSerial: "scan lookup",
  resolveScannedItemId: "scan lookup",
  liveSearchAction: "public search",
  verifyReceiptSealAction: "re-derives and verifies a seal; never mutates",
  exportStaleDevicesAction: "builds a workbook from reads",
  exportDroppedDevicesAction: "builds a workbook from reads",
  previewItemRenameAction: "preview only",
  analyzeImportAction: "parse + plan; the commit half is guarded",
  parseReceiptForm: "pure form parsing, not an action",
  deleteDraftAndReturnToAccountAction:
    "delegates to deleteDraftAction, which carries the guard",
  loginAction: "unauthenticated",
  logoutAction: "unauthenticated",
  requestPasswordResetAction: "unauthenticated; carries its own demo block",
  resetPasswordAction:
    "unauthenticated; no token is ever minted for a demo account",
  registerAction: "unauthenticated",
  resendVerificationAction: "unauthenticated",
  unlockAction: "unauthenticated",
};

const EXPORTED_FUNCTION = /^export (?:async )?function /m;

type ExportedFunction = {
  name: string;
  file: string;
  body: string;
};

function actionFiles(): string[] {
  const files: string[] = [];
  for (const dir of ACTION_DIRS) {
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".ts")) continue;
      if (entry.endsWith(".test.ts")) continue;
      files.push(path.join(dir, entry));
    }
  }
  return files;
}

// Split the source at every `export function` / `export async function`, so
// each exported body is examined on its own. Chunk 0 is everything before the
// first export (imports, helpers) and is discarded.
function exportedFunctions(): ExportedFunction[] {
  const found: ExportedFunction[] = [];
  for (const file of actionFiles()) {
    const source = readFileSync(file, "utf8");
    const chunks = source.split(EXPORTED_FUNCTION).slice(1);
    for (const chunk of chunks) {
      const name = chunk.match(/^(\w+)/)?.[1];
      if (!name) continue;
      found.push({ name, file, body: stripComments(chunk) });
    }
  }
  return found;
}

/**
 * Remove block and line comments before looking for the guard.
 *
 * Without this the check is satisfied by PROSE: `auth.ts` carries a comment
 * explaining why `denyReadOnly` cannot apply to an unauthenticated action, and
 * that comment alone would mark the action as guarded. A test whose assertion
 * can be passed by writing about the thing rather than doing it is not an
 * enforcement mechanism, and this is the only mechanical enforcement the
 * feature has.
 *
 * Deliberately naive — it is not a TypeScript parser, so a `//` inside a string
 * literal would confuse it. No action file contains one, and the failure
 * direction is safe: a mangled body loses its guard match and the test fails
 * LOUDLY rather than quietly passing something unguarded.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("read-only demo account coverage", () => {
  it("every exported action calls denyReadOnly or is allowlisted", () => {
    const unguarded = exportedFunctions()
      .filter((fn) => !(fn.name in ALLOWLIST))
      .filter((fn) => !fn.body.includes("denyReadOnly"))
      .map((fn) => `${fn.name} (${path.relative(process.cwd(), fn.file)})`);

    expect(
      unguarded,
      `These exported Server Actions never call denyReadOnly():\n` +
        `${unguarded.map((n) => `  - ${n}`).join("\n")}\n` +
        `Add the guard. Only add an ALLOWLIST entry in ` +
        `src/app/actions/read-only-coverage.test.ts if you have verified the ` +
        `action performs no database write.`,
    ).toEqual([]);
  });

  // Guards the check itself. If comment-stripping regresses, the coverage test
  // above starts accepting a comment in place of a call and silently stops
  // enforcing anything — the failure mode that matters most here, because it
  // looks exactly like a passing suite.
  it("does not count a guard mentioned only in a comment", () => {
    const commentOnly = `foo() {\n  // denyReadOnly cannot apply here\n  /* denyReadOnly */\n}`;
    expect(stripComments(commentOnly)).not.toContain("denyReadOnly");

    const realCall = `foo() {\n  const denied = denyReadOnly(user);\n}`;
    expect(stripComments(realCall)).toContain("denyReadOnly");
  });

  it("has no stale allowlist entries", () => {
    const live = new Set(exportedFunctions().map((fn) => fn.name));
    const stale = Object.keys(ALLOWLIST).filter((name) => !live.has(name));

    expect(
      stale,
      `These ALLOWLIST entries name no exported function in ` +
        `src/app/actions or src/app/admin/actions:\n` +
        `${stale.map((n) => `  - ${n} ("${ALLOWLIST[n]}")`).join("\n")}\n` +
        `Remove them, or the allowlist silently excuses a name that comes back later.`,
    ).toEqual([]);
  });
});
