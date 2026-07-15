import { beforeAll, beforeEach, expect, test } from "vitest";
import prisma from "@/lib/prisma";
import { resetDb, migrateTestDb } from "../../../tests/helpers/db";
import { listContacts, createContact, updateContact, deleteContact } from "./contacts.service";
import { ContactError } from "./contacts.errors";

let adminId: string;

beforeAll(() => migrateTestDb());
beforeEach(async () => {
  await resetDb();
  const a = await prisma.user.create({
    data: { name: "Admin", email: "a@x.co", passwordHash: "x", role: "ADMIN" },
  });
  adminId = a.id;
});

const BASE = { firstName: "Jane", lastName: "Doe", email: "jane@unit.mil" };

test("createContact stores the contact and stamps the creator", async () => {
  const c = await createContact({ ...BASE, rank: "SGT", unit: "A Co" }, adminId);
  expect(c.firstName).toBe("Jane");
  expect(c.lastName).toBe("Doe");
  expect(c.email).toBe("jane@unit.mil");
  expect(c.rank).toBe("SGT");
  expect(c.createdById).toBe(adminId);
});

test("createContact lowercases the email and collapses blank optionals to null", async () => {
  const c = await createContact({ ...BASE, email: "  JANE@Unit.MIL ", rank: "  ", unit: "" }, adminId);
  expect(c.email).toBe("jane@unit.mil");
  expect(c.rank).toBeNull();
  expect(c.unit).toBeNull();
});

test("createContact rejects a duplicate email regardless of case", async () => {
  await createContact(BASE, adminId);
  await expect(createContact({ ...BASE, firstName: "Janet", email: "JANE@UNIT.MIL" }, adminId))
    .rejects.toMatchObject({ code: "DUPLICATE_EMAIL" });
});

test("listContacts orders by last name, then first name", async () => {
  await createContact({ firstName: "Zoe", lastName: "Alvarez", email: "z@u.mil" }, adminId);
  await createContact({ firstName: "Bob", lastName: "Smith", email: "b@u.mil" }, adminId);
  await createContact({ firstName: "Amy", lastName: "Smith", email: "a@u.mil" }, adminId);
  expect((await listContacts()).map((c) => `${c.lastName},${c.firstName}`))
    .toEqual(["Alvarez,Zoe", "Smith,Amy", "Smith,Bob"]);
});

test("updateContact changes the stored fields", async () => {
  const c = await createContact(BASE, adminId);
  const u = await updateContact({ id: c.id, ...BASE, lastName: "Roe", unit: "B Co" });
  expect(u.lastName).toBe("Roe");
  expect(u.unit).toBe("B Co");
});

test("updateContact clears an optional the admin blanked out", async () => {
  // Prisma reads `undefined` as "leave this column alone", and the schema turns
  // a blank field into `undefined` — so this is the difference between clearing
  // a unit and silently keeping the old one.
  const c = await createContact({ ...BASE, rank: "SGT", unit: "A Co" }, adminId);
  const u = await updateContact({ id: c.id, ...BASE, rank: "", unit: "  " });
  expect(u.rank).toBeNull();
  expect(u.unit).toBeNull();
});

test("updateContact rejects an email already used by another contact", async () => {
  await createContact(BASE, adminId);
  const other = await createContact({ firstName: "Bob", lastName: "Smith", email: "bob@unit.mil" }, adminId);
  await expect(updateContact({ id: other.id, firstName: "Bob", lastName: "Smith", email: "jane@unit.mil" }))
    .rejects.toMatchObject({ code: "DUPLICATE_EMAIL" });
});

test("deleteContact removes it; deleting a missing contact throws NOT_FOUND", async () => {
  const c = await createContact(BASE, adminId);
  await deleteContact(c.id);
  expect(await listContacts()).toEqual([]);
  await expect(deleteContact("nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("the book survives deletion of the account that created it", async () => {
  await createContact(BASE, adminId);
  await prisma.user.delete({ where: { id: adminId } });
  const rows = await listContacts();
  expect(rows).toHaveLength(1);
  expect(rows[0].createdById).toBeNull();
});

test("ContactError is thrown as a ContactError instance", async () => {
  await createContact(BASE, adminId);
  await expect(createContact(BASE, adminId)).rejects.toBeInstanceOf(ContactError);
});
