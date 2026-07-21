import { describe, it, expect, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { canonicalize, generateCryptographicSeal, verifyCryptographicSeal, CryptoKeyUnavailableError } from "./crypto";

const saved = process.env.SIGNING_PRIVATE_KEY;
function setKey() {
  const { privateKey } = generateKeyPairSync("ed25519");
  process.env.SIGNING_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}
afterEach(() => {
  if (saved === undefined) delete process.env.SIGNING_PRIVATE_KEY;
  else process.env.SIGNING_PRIVATE_KEY = saved;
});

describe("canonicalize", () => {
  it("is key-order independent", () => {
    expect(canonicalize({ a: 1, b: [2, 3] })).toBe(canonicalize({ b: [2, 3], a: 1 }));
  });
  it("is NOT array-order independent", () => {
    expect(canonicalize({ a: [1, 2] })).not.toBe(canonicalize({ a: [2, 1] }));
  });
});

describe("generate + verify round trip", () => {
  it("verifies a freshly generated seal", () => {
    setKey();
    const sig = generateCryptographicSeal({ x: 1, y: "z" });
    expect(sig).toBeTypeOf("string");
    expect(verifyCryptographicSeal({ y: "z", x: 1 }, sig as string)).toBe(true);
  });
  it("fails verification when the manifest is altered", () => {
    setKey();
    const sig = generateCryptographicSeal({ x: 1 }) as string;
    expect(verifyCryptographicSeal({ x: 2 }, sig)).toBe(false);
  });
  it("returns null from generate when the key is unset", () => {
    delete process.env.SIGNING_PRIVATE_KEY;
    expect(generateCryptographicSeal({ x: 1 })).toBeNull();
  });
  it("throws CryptoKeyUnavailableError from verify when the key is unset", () => {
    delete process.env.SIGNING_PRIVATE_KEY;
    expect(() => verifyCryptographicSeal({ x: 1 }, "AA==")).toThrow(CryptoKeyUnavailableError);
  });
});
