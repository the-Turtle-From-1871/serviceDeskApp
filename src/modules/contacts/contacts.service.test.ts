import { beforeEach, expect, test } from "vitest";
import prisma from "@/lib/prisma";
import { resetDb } from "../../../tests/helpers/db";
import { listContacts, searchContacts, createContact, updateContact, deleteContact, upsertContactFromParty } from "./contacts.service";
import { ContactError } from "./contacts.errors";

let adminId: string;

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

test("searchContacts matches a single token across name/email/unit, and excludes rank", async () => {
  await createContact({ firstName: "Jane", lastName: "Doe", email: "jane.doe@unit.mil", rank: "SGT", unit: "A Co" }, adminId);
  await createContact({ firstName: "Bob", lastName: "Smith", email: "bob@unit.mil", unit: "B Co" }, adminId);
  expect((await searchContacts("jane")).map((c) => c.email)).toEqual(["jane.doe@unit.mil"]);
  expect((await searchContacts("smith")).map((c) => c.email)).toEqual(["bob@unit.mil"]);
  expect((await searchContacts("jane.doe@")).map((c) => c.email)).toEqual(["jane.doe@unit.mil"]);
  expect(await searchContacts("SGT")).toEqual([]); // rank is deliberately not searched
});

test("searchContacts matches a full name in either token order (token-AND)", async () => {
  await createContact({ firstName: "Jane", lastName: "Doe", email: "jd@unit.mil" }, adminId);
  expect((await searchContacts("jane doe")).map((c) => c.email)).toEqual(["jd@unit.mil"]);
  expect((await searchContacts("doe jane")).map((c) => c.email)).toEqual(["jd@unit.mil"]);
});

test("searchContacts returns [] for a blank query and caps results at 8", async () => {
  expect(await searchContacts("   ")).toEqual([]);
  for (let i = 0; i < 12; i++) {
    await createContact({ firstName: `First${i}`, lastName: "Sametoken", email: `c${i}@u.mil` }, adminId);
  }
  expect((await searchContacts("sametoken")).length).toBe(8);
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

// --- upsertContactFromParty: the hand-receipt auto-save -----------------------

const PARTY = {
  isDcsim: false,
  name: "Doe, Jane",
  rank: "SGT",
  unit: "A Co",
  contact: "555-0100",
  email: "jane@unit.mil",
};

test("upsertContactFromParty files a new party into the book and stamps the creator", async () => {
  const c = await upsertContactFromParty(PARTY, adminId);
  expect(c).toMatchObject({
    firstName: "Jane", lastName: "Doe", rank: "SGT",
    unit: "A Co", contactNumber: "555-0100", email: "jane@unit.mil",
    createdById: adminId,
  });
  expect(await listContacts()).toHaveLength(1);
});

test("upsertContactFromParty updates an existing contact rather than duplicating", async () => {
  await createContact({ ...BASE, rank: "PFC", unit: "Old Co" }, adminId);
  const c = await upsertContactFromParty({ ...PARTY, unit: "New Co", contact: "555-0199" }, adminId);
  expect(c).toMatchObject({ rank: "SGT", unit: "New Co", contactNumber: "555-0199" });
  expect(await listContacts()).toHaveLength(1);
});

test("upsertContactFromParty matches an existing contact case-insensitively (citext email)", async () => {
  await createContact(BASE, adminId);
  await upsertContactFromParty({ ...PARTY, email: "JANE@Unit.MIL" }, adminId);
  expect(await listContacts()).toHaveLength(1);
});

test("upsertContactFromParty never reassigns authorship of an existing entry", async () => {
  const other = await prisma.user.create({
    data: { name: "Tech", email: "t@x.co", passwordHash: "x", role: "USER" },
  });
  await createContact(BASE, adminId);
  const c = await upsertContactFromParty(PARTY, other.id);
  expect(c?.createdById).toBe(adminId);
});

test("upsertContactFromParty leaves an existing rank alone when the receipt's is blank", async () => {
  // A blank rank on the builder is far likelier an omission than a correction,
  // so it must not wipe a rank someone already recorded.
  await createContact({ ...BASE, rank: "SGT" }, adminId);
  const c = await upsertContactFromParty({ ...PARTY, rank: "" }, adminId);
  expect(c?.rank).toBe("SGT");
});

test("upsertContactFromParty drops an over-long rank instead of losing the contact", async () => {
  const c = await upsertContactFromParty({ ...PARTY, rank: "A".repeat(21) }, adminId);
  expect(c).not.toBeNull();
  expect(c?.rank).toBeNull();
});

test("upsertContactFromParty skips a DCSIM party — the book holds outside people only", async () => {
  expect(await upsertContactFromParty({ ...PARTY, isDcsim: true }, adminId)).toBeNull();
  expect(await listContacts()).toEqual([]);
});

test("upsertContactFromParty skips a name it cannot split, and a missing email", async () => {
  expect(await upsertContactFromParty({ ...PARTY, name: "Smith" }, adminId)).toBeNull();
  expect(await upsertContactFromParty({ ...PARTY, email: "  " }, adminId)).toBeNull();
  expect(await upsertContactFromParty({ ...PARTY, email: undefined }, adminId)).toBeNull();
  expect(await listContacts()).toEqual([]);
});

test("upsertContactFromParty splits an uncommaed name first-token-is-given-name", async () => {
  const c = await upsertContactFromParty({ ...PARTY, name: "Jane Van Der Berg" }, adminId);
  expect(c).toMatchObject({ firstName: "Jane", lastName: "Van Der Berg" });
});

test("upsertContactFromParty lowercases the email so the saved row is findable", async () => {
  const c = await upsertContactFromParty({ ...PARTY, email: "  JANE@Unit.MIL " }, adminId);
  expect(c?.email).toBe("jane@unit.mil");
});

test("upsertContactFromParty never rewrites an existing contact's name split", async () => {
  // The corruption this guards against is self-inflicted by the app's own
  // autofill: ContactCombobox's onPick writes `"${firstName} ${lastName}"` into
  // the single name field, so a curated "Mary Jo" / "Smith" comes back as
  // "Mary Jo Smith" and re-parses to "Mary" / "Jo Smith". Picking that contact
  // and filing the receipt — without anyone typing a character — must not
  // silently refile them. The name is create-only, like createdById.
  await createContact({ firstName: "Mary Jo", lastName: "Smith", email: "jane@unit.mil" }, adminId);
  const c = await upsertContactFromParty({ ...PARTY, name: "Mary Jo Smith" }, adminId);
  expect(c).toMatchObject({ firstName: "Mary Jo", lastName: "Smith" });
});

test("upsertContactFromParty still refreshes contact details while leaving the name alone", async () => {
  await createContact({ firstName: "Mary Jo", lastName: "Smith", email: "jane@unit.mil", unit: "Old Co" }, adminId);
  const c = await upsertContactFromParty({ ...PARTY, name: "Mary Jo Smith", unit: "New Co" }, adminId);
  expect(c).toMatchObject({ firstName: "Mary Jo", lastName: "Smith", unit: "New Co" });
});

test("refreshExisting: false still files someone who is not in the book yet", async () => {
  const c = await upsertContactFromParty(PARTY, adminId, { refreshExisting: false });
  expect(c).toMatchObject({ firstName: "Jane", lastName: "Doe", unit: "A Co", createdById: adminId });
});

test("refreshExisting: false leaves an existing contact completely untouched", async () => {
  // The sender's fields are seeded from a frozen snapshot on an old receipt, so
  // they must never overwrite a correction an admin made since.
  const before = await createContact(
    { ...BASE, rank: "SSG", unit: "Corrected Co", contactNumber: "555-9999" },
    adminId,
  );
  const c = await upsertContactFromParty(
    { ...PARTY, rank: "SGT", unit: "Stale Co", contact: "555-0000" },
    adminId,
    { refreshExisting: false },
  );
  expect(c).toMatchObject({ rank: "SSG", unit: "Corrected Co", contactNumber: "555-9999" });
  expect(c?.id).toBe(before.id);
  expect(await listContacts()).toHaveLength(1);
});
