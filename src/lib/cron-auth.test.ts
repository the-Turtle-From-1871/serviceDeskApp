import { describe, it, expect } from "vitest";
import { hasValidBearerSecret } from "./cron-auth";

const reqWith = (auth?: string) =>
  new Request("https://example.test/api/x", auth ? { headers: { authorization: auth } } : undefined);

describe("hasValidBearerSecret", () => {
  it("accepts an exact Bearer match", () => {
    expect(hasValidBearerSecret(reqWith("Bearer s3cret"), "s3cret")).toBe(true);
  });

  it("rejects a wrong secret of the same length", () => {
    expect(hasValidBearerSecret(reqWith("Bearer s3cres"), "s3cret")).toBe(false);
  });

  it("rejects a wrong secret of a different length", () => {
    expect(hasValidBearerSecret(reqWith("Bearer nope"), "s3cret")).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(hasValidBearerSecret(reqWith(), "s3cret")).toBe(false);
  });

  it("rejects the bare secret without the Bearer prefix", () => {
    expect(hasValidBearerSecret(reqWith("s3cret"), "s3cret")).toBe(false);
  });

  it("FAILS CLOSED when the secret is not configured", () => {
    // The whole point: an unset env var must never mean "let everyone in".
    expect(hasValidBearerSecret(reqWith("Bearer anything"), undefined)).toBe(false);
    expect(hasValidBearerSecret(reqWith("Bearer "), "")).toBe(false);
  });
});
