import { expect, test } from "vitest";
import { signatureSha256, signatureByteLen } from "./signature-hash";

// Known vector: SHA-256 of the empty string. Pins the algorithm and the encoding
// (lowercase hex), both of which the backfill migration depends on matching.
test("signatureSha256 is lowercase hex SHA-256 of the UTF-8 bytes", () => {
  expect(signatureSha256("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  expect(signatureSha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  expect(signatureSha256("abc")).toMatch(/^[0-9a-f]{64}$/);
});

test("identical images hash identically, different ones do not", () => {
  const a = "data:image/png;base64,AAA";
  expect(signatureSha256(a)).toBe(signatureSha256(`${a}`));
  expect(signatureSha256(a)).not.toBe(signatureSha256("data:image/png;base64,AAB"));
});

test("signatureByteLen counts UTF-8 bytes, not UTF-16 code units", () => {
  expect(signatureByteLen("abc")).toBe(3);
  // A 2-byte character: length is 1 but the stored byte count is 2, which is what
  // the migration's octet_length(convert_to(...,'UTF8')) reports.
  expect(signatureByteLen("é")).toBe(2);
});
