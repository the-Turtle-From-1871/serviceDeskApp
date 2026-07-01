import { beforeAll, beforeEach, expect, test } from "vitest";
import { migrateTestDb, resetDb } from "../../../tests/helpers/db";
import { createUser, registerUser, setUserActive, setUserRole, listUsers, changeUserPassword } from "./users.service";
import { verifyPassword } from "@/lib/password";

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

test("createUser stores rank and lowercases the email", async () => {
  const u = await createUser({ rank: "SGT", name: "Pat", email: "Pat.X@Unit.MIL", password: "password123", role: "USER" });
  expect(u.rank).toBe("SGT");
  expect(u.email).toBe("pat.x@unit.mil");
});

test("registerUser creates an active USER (self-registration)", async () => {
  const u = await registerUser({ rank: "SPC", name: "Reg", email: "Reg.User@X.co", password: "password123" });
  expect(u.role).toBe("USER");
  expect(u.isActive).toBe(true);
  expect(u.email).toBe("reg.user@x.co");
  expect(u.rank).toBe("SPC");
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

test("changeUserPassword updates the hash when the current password is correct", async () => {
  const u = await createUser({ name: "Pat", email: "pat@x.co", password: "password123", role: "USER" });
  await changeUserPassword(u.id, "password123", "newpassword456");
  const after = await listUsers();
  expect(await verifyPassword("newpassword456", after[0].passwordHash)).toBe(true);
  expect(await verifyPassword("password123", after[0].passwordHash)).toBe(false);
});

test("changeUserPassword rejects a wrong current password", async () => {
  const u = await createUser({ name: "Pat", email: "pat@x.co", password: "password123", role: "USER" });
  await expect(changeUserPassword(u.id, "wrongpassword", "newpassword456")).rejects.toMatchObject({
    code: "INVALID_CURRENT",
  });
});
