import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isReadOnlyDemo } from "@/lib/read-only-demo";

// A demo account's credentials are shared deliberately, and the account holds
// ADMIN so the portal renders. So the password-reset path is an account-takeover
// route for whoever can read that inbox — and `denyReadOnly` cannot close it,
// because requestPasswordResetAction is unauthenticated and has no session.
//
// The predicate is pure, so the decision is asserted directly here rather than
// driving the whole action (which needs Turnstile, the rate limiter and
// `after()`). What the action itself must guarantee — that the skip happens
// BEFORE a token is minted — is pinned against the source below.
describe("password reset for a demo account", () => {
  const ORIGINAL = process.env.READ_ONLY_DEMO_EMAILS;
  beforeEach(() => {
    process.env.READ_ONLY_DEMO_EMAILS = "test@gmail.com";
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.READ_ONLY_DEMO_EMAILS;
    else process.env.READ_ONLY_DEMO_EMAILS = ORIGINAL;
  });

  it("identifies the demo address the reset path must skip", () => {
    expect(isReadOnlyDemo("test@gmail.com")).toBe(true);
  });

  it("leaves every other address alone", () => {
    expect(isReadOnlyDemo("someone@dcsim.us")).toBe(false);
  });
});

describe("requestPasswordResetAction's demo block", () => {
  const src = readFileSync(join(process.cwd(), "src/app/actions/auth.ts"), "utf8");

  it("skips the demo account before a reset token is ever minted", () => {
    const guard = src.indexOf("isReadOnlyDemo(user.email)");
    const mint = src.indexOf("createPasswordResetToken(");
    expect(guard, "the demo block is missing from auth.ts").toBeGreaterThan(-1);
    expect(mint, "createPasswordResetToken call not found").toBeGreaterThan(-1);
    // The ORDER is the whole control. A guard placed after the mint would stop
    // the email while leaving a usable token sitting in the database.
    expect(guard).toBeLessThan(mint);
  });

  it("returns the generic success rather than a distinct refusal", () => {
    // Anti-enumeration: the demo skip must be one of the silent `return`s inside
    // the deferred block, never an early `return { error: ... }` that would tell
    // an anonymous caller this address is special.
    const block = src.slice(
      src.indexOf("isReadOnlyDemo(user.email)"),
      src.indexOf("isReadOnlyDemo(user.email)") + 60,
    );
    expect(block).toContain("return;");
  });
});
