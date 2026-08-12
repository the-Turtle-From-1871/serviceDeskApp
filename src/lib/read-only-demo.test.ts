import { describe, it, expect, afterEach } from "vitest";
import { isReadOnlyDemo } from "./read-only-demo";

const ORIGINAL = process.env.READ_ONLY_DEMO_EMAILS;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.READ_ONLY_DEMO_EMAILS;
  else process.env.READ_ONLY_DEMO_EMAILS = ORIGINAL;
});

describe("isReadOnlyDemo", () => {
  it("matches a listed address", () => {
    process.env.READ_ONLY_DEMO_EMAILS = "test@gmail.com";
    expect(isReadOnlyDemo("test@gmail.com")).toBe(true);
  });

  it("is case-insensitive on both sides", () => {
    process.env.READ_ONLY_DEMO_EMAILS = "Test@Gmail.COM";
    expect(isReadOnlyDemo("TEST@gmail.com")).toBe(true);
  });

  it("tolerates whitespace and empty entries", () => {
    process.env.READ_ONLY_DEMO_EMAILS = " a@x.com , , b@x.com ";
    expect(isReadOnlyDemo("b@x.com")).toBe(true);
    expect(isReadOnlyDemo("a@x.com")).toBe(true);
  });

  it("trims the address it is asked about", () => {
    process.env.READ_ONLY_DEMO_EMAILS = "test@gmail.com";
    expect(isReadOnlyDemo("  test@gmail.com  ")).toBe(true);
  });

  it("does not match an unlisted address", () => {
    process.env.READ_ONLY_DEMO_EMAILS = "test@gmail.com";
    expect(isReadOnlyDemo("real@dcsim.us")).toBe(false);
  });

  // Not a substring match: a demo address must not drag in every address that
  // happens to contain it.
  it("matches whole addresses only", () => {
    process.env.READ_ONLY_DEMO_EMAILS = "test@gmail.com";
    expect(isReadOnlyDemo("nottest@gmail.com")).toBe(false);
    expect(isReadOnlyDemo("test@gmail.com.au")).toBe(false);
  });

  // The fail-open case, pinned so it stays a decision rather than an accident.
  it("returns false when the variable is unset or empty", () => {
    delete process.env.READ_ONLY_DEMO_EMAILS;
    expect(isReadOnlyDemo("test@gmail.com")).toBe(false);
    process.env.READ_ONLY_DEMO_EMAILS = "   ";
    expect(isReadOnlyDemo("test@gmail.com")).toBe(false);
    process.env.READ_ONLY_DEMO_EMAILS = " , , ";
    expect(isReadOnlyDemo("test@gmail.com")).toBe(false);
  });

  it("never matches a blank or missing email", () => {
    process.env.READ_ONLY_DEMO_EMAILS = "test@gmail.com,";
    expect(isReadOnlyDemo("")).toBe(false);
    expect(isReadOnlyDemo("   ")).toBe(false);
    expect(isReadOnlyDemo(null)).toBe(false);
    expect(isReadOnlyDemo(undefined)).toBe(false);
  });
});
