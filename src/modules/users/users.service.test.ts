import { beforeAll, beforeEach, expect, test } from "vitest";
import { migrateTestDb, resetDb } from "../../../tests/helpers/db";
import { createUser, setUserActive, setUserRole, listUsers } from "./users.service";

beforeAll(() => migrateTestDb());
beforeEach(() => resetDb());

test("createUser hashes password and defaults role USER", async () => {
  const u = await createUser({ name: "Pat", email: "pat@x.co", password: "password123", role: "USER" });
  expect(u.role).toBe("USER");
  expect(u.passwordHash).not.toBe("password123");
});

test("createUser rejects short passwords", async () => {
  await expect(createUser({ name: "Pat", email: "p@x.co", password: "short", role: "USER" })).rejects.toThrow();
});

test("setUserActive toggles the flag", async () => {
  const u = await createUser({ name: "Pat", email: "pat@x.co", password: "password123", role: "USER" });
  const off = await setUserActive(u.id, false);
  expect(off.isActive).toBe(false);
});

test("setUserRole promotes to ADMIN", async () => {
  const u = await createUser({ name: "Pat", email: "pat@x.co", password: "password123", role: "USER" });
  const admin = await setUserRole(u.id, "ADMIN");
  expect(admin.role).toBe("ADMIN");
});

test("listUsers returns created users", async () => {
  await createUser({ name: "A", email: "a@x.co", password: "password123", role: "USER" });
  expect(await listUsers()).toHaveLength(1);
});
