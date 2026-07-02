import { beforeAll, beforeEach, expect, test } from "vitest";
import { migrateTestDb, resetDb } from "../../../tests/helpers/db";
import { createUser, setUserActive, setUserRole, listUsers, changeUserPassword } from "./users.service";
import { verifyPassword } from "@/lib/password";

beforeAll(() => migrateTestDb());
beforeEach(() => resetDb());

const base = { unit: undefined, contactNumber: undefined } as const;

test("createUser hashes password and defaults role USER", async () => {
  const u = await createUser({ name: "Pat", email: "pat@x.co", password: "password123", role: "USER", ...base });
  expect(u.role).toBe("USER");
  expect(u.passwordHash).not.toBe("password123");
});

test("createUser rejects short passwords", async () => {
  await expect(
    createUser({ name: "Pat", email: "p@x.co", password: "short", role: "USER", ...base })
  ).rejects.toThrow();
});

test("createUser stores rank and lowercases the email", async () => {
  const u = await createUser({
    rank: "SGT",
    name: "Pat",
    email: "Pat.X@Unit.MIL",
    password: "password123",
    role: "USER",
    ...base,
  });
  expect(u.rank).toBe("SGT");
  expect(u.email).toBe("pat.x@unit.mil");
});

test("createUser persists unit and contactNumber", async () => {
  const u = await createUser({
    name: "Pat",
    email: "pat.unit@x.co",
    password: "password123",
    role: "USER",
    unit: "A Co, 1-1 IN",
    contactNumber: "808-555-0100",
  });
  expect(u.unit).toBe("A Co, 1-1 IN");
  expect(u.contactNumber).toBe("808-555-0100");
});

test("setUserActive toggles the flag", async () => {
  const u = await createUser({ name: "Pat", email: "pat@x.co", password: "password123", role: "USER", ...base });
  const off = await setUserActive(u.id, false);
  expect(off.isActive).toBe(false);
});

test("setUserRole promotes to ADMIN", async () => {
  const u = await createUser({ name: "Pat", email: "pat@x.co", password: "password123", role: "USER", ...base });
  const admin = await setUserRole(u.id, "ADMIN");
  expect(admin.role).toBe("ADMIN");
});

test("listUsers returns created users", async () => {
  await createUser({ name: "A", email: "a@x.co", password: "password123", role: "USER", ...base });
  expect(await listUsers()).toHaveLength(1);
});

test("changeUserPassword updates the hash when the current password is correct", async () => {
  const u = await createUser({ name: "Pat", email: "pat@x.co", password: "password123", role: "USER", ...base });
  await changeUserPassword(u.id, "password123", "newpassword456");
  const after = await listUsers();
  expect(await verifyPassword("newpassword456", after[0].passwordHash)).toBe(true);
  expect(await verifyPassword("password123", after[0].passwordHash)).toBe(false);
});

test("changeUserPassword rejects a wrong current password", async () => {
  const u = await createUser({ name: "Pat", email: "pat@x.co", password: "password123", role: "USER", ...base });
  await expect(changeUserPassword(u.id, "wrongpassword", "newpassword456")).rejects.toMatchObject({
    code: "INVALID_CURRENT",
  });
});
