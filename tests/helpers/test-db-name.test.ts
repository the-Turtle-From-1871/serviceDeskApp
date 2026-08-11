import { describe, it, expect } from "vitest";
import { templateDbName, workerDbName, MAX_TEST_WORKERS } from "./test-db-name";

const A = "/c/inventoryApp";
const B = "/c/inventoryApp/.claude/worktrees/bulk-rename";

describe("test database names", () => {
  it("always contains handreceipt_test, so resetDb's safety belt still matches", () => {
    // resetDb() refuses to TRUNCATE unless DATABASE_URL contains this substring.
    // Shortening the prefix would silently disable the guard.
    expect(templateDbName(A)).toContain("handreceipt_test");
    for (let i = 1; i <= MAX_TEST_WORKERS; i++) {
      expect(workerDbName(i, A)).toContain("handreceipt_test");
    }
  });

  it("is stable for the same path", () => {
    expect(workerDbName(1, A)).toBe(workerDbName(1, A));
    expect(templateDbName(A)).toBe(templateDbName(A));
  });

  it("differs between checkouts, so concurrent worktrees cannot collide", () => {
    expect(workerDbName(1, A)).not.toBe(workerDbName(1, B));
    expect(templateDbName(A)).not.toBe(templateDbName(B));
  });

  it("differs between workers within a checkout", () => {
    expect(workerDbName(1, A)).not.toBe(workerDbName(2, A));
  });

  it("never collides with the template", () => {
    for (let i = 1; i <= MAX_TEST_WORKERS; i++) {
      expect(workerDbName(i, A)).not.toBe(templateDbName(A));
    }
  });

  it("ignores path case, so Windows drive-letter casing does not fork the name", () => {
    expect(workerDbName(1, "/C/InventoryApp")).toBe(workerDbName(1, "/c/inventoryapp"));
  });

  it("emits only characters safe to splice into a DDL identifier", () => {
    // Database names cannot be parameterised, so this charset assertion IS the
    // injection guard.
    for (const n of [templateDbName(B), workerDbName(3, B)]) {
      expect(n).toMatch(/^[a-z0-9_]+$/);
    }
  });

  it("stays inside Postgres's 63-byte identifier limit", () => {
    expect(templateDbName(B).length).toBeLessThan(63);
    expect(workerDbName(MAX_TEST_WORKERS, B).length).toBeLessThan(63);
  });
});
