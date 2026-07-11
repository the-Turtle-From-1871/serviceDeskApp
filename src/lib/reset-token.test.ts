import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { generateResetToken, hashToken } from "./reset-token";

describe("reset-token", () => {
  it("generateResetToken returns 64 hex chars (32 random bytes) and is unique", () => {
    const a = generateResetToken();
    const b = generateResetToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  it("hashToken is a deterministic sha256 hex of the raw token", () => {
    expect(hashToken("abc")).toBe(createHash("sha256").update("abc").digest("hex"));
    expect(hashToken("abc")).toBe(hashToken("abc"));
    expect(hashToken("abc")).not.toBe(hashToken("abd"));
    expect(hashToken("anything")).toHaveLength(64);
  });
});
