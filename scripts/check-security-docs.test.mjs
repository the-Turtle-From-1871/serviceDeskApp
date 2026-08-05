import { describe, it, expect } from "vitest";
import { WATCHED } from "./check-security-docs.mjs";

// Guards the WATCHED list itself against the failure shape that bit
// src/proxy.ts's matcher: a merge, a refactor, or a bad conflict resolution
// can drop an entry (or leave a regex that no longer matches after a file
// move) and check-security-docs.mjs says NOTHING — CI still passes, and the
// next change to that file ships without docs/SECURITY.md being touched,
// which is the exact scenario the script exists to prevent.
//
// Asserts on MATCHING, not on the literal regex source, so a legitimate
// regex rewrite still passes while a dropped entry or a renamed/relocated
// file that falls out from under an anchored pattern fails loudly.
//
// If importing this module ever again executes the CLI's git/process.exit
// side effects (the guard at the bottom of check-security-docs.mjs
// regressing), this whole test file fails to even run rather than passing
// silently — there is no path where a broken guard produces a green check.
function isWatched(path) {
  return WATCHED.some(([re]) => re.test(path));
}

describe("check-security-docs WATCHED list", () => {
  const introducedThisBranch = [
    "src/lib/cron-auth.ts",
    "src/modules/items/import-actor.ts",
    "src/app/api/items/import/route.ts",
    // `/` left the proxy's PIN gate so the home page could be publicly
    // readable; these two are what took over gating the data behind it, and an
    // unwatched change to either silently re-opens the item/receipt catalog.
    "src/lib/public-access-guard.ts",
    "src/app/actions/search.ts",
    // The scoped receipt-link bypass and the shared crypto primitives under it.
    "src/lib/receipt-link-token.ts",
    "src/lib/web-hmac.ts",
  ];

  it.each(introducedThisBranch)("covers %s", (path) => {
    expect(isWatched(path)).toBe(true);
  });

  it("does not watch an unrelated file with a similar name", () => {
    // Sanity check on the assertion helper itself: a path that should NOT be
    // covered must read as not-covered, or `isWatched` could be trivially
    // satisfying every case above by accident (e.g. a stray `.*` somewhere).
    expect(isWatched("src/modules/items/import-actor.test.ts")).toBe(false);
    expect(isWatched("src/app/api/items/import/route.test.ts")).toBe(false);
  });
});
