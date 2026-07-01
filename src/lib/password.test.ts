import { expect, test } from "vitest";
import { hashPassword, verifyPassword } from "./password";

test("hash then verify succeeds for correct password", async () => {
  const hash = await hashPassword("s3cret!");
  expect(hash).not.toBe("s3cret!");
  expect(await verifyPassword("s3cret!", hash)).toBe(true);
});

test("verify fails for wrong password", async () => {
  const hash = await hashPassword("s3cret!");
  expect(await verifyPassword("nope", hash)).toBe(false);
});
