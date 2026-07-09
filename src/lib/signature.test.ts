import { describe, it, expect } from "vitest";
import { signatureError, MAX_SIGNATURE_LEN } from "./signature";

describe("signatureError", () => {
  it("requires a value", () => {
    expect(signatureError("")).toMatch(/required/i);
  });
  it("rejects a non-PNG-data-url", () => {
    expect(signatureError("hello")).toMatch(/invalid/i);
    expect(signatureError("data:image/jpeg;base64,xxxx")).toMatch(/invalid/i);
  });
  it("rejects an over-length value", () => {
    const big = "data:image/png;base64," + "a".repeat(MAX_SIGNATURE_LEN);
    expect(signatureError(big)).toMatch(/too large/i);
  });
  it("accepts a valid PNG data url", () => {
    expect(signatureError("data:image/png;base64,iVBORw0KGgo=")).toBeNull();
  });
});
