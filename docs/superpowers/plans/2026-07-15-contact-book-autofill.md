# Contact Book + Recipient Autofill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a shared, admin-curated contact book managed on `/admin/users`, and a type-ahead on the hand-receipt builder's recipient side that fills rank/unit/contact/email from a picked contact.

**Architecture:** A new `Contact` table (split `firstName`/`lastName` so last-name ordering is an indexed DB sort, `citext` unique email for dedupe). Admin-only writes via server actions mirroring `admin/actions/users.ts`. The builder loads the whole book once inside the **existing** `Promise.all` in `receipts/new/page.tsx` and filters it in memory per keystroke — no per-keystroke network, so no debounce, no race guard, no stale-response bugs. `PartyFields`' four uncontrolled recipient fields are lifted to state so a pick can drive them.

**Tech Stack:** Next.js 16 (App Router, Server Components), React 19, Prisma 7 + PostgreSQL (`citext`), Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-15-contact-book-autofill-design.md`

## Global Constraints

- **Auth first.** Every server action calls `requireAdmin()` (writes) or `requireUser()` (reads) as its first statement. Never trust a client-supplied id for ownership.
- **Never trust client input for identity.** `createdById` comes from the authenticated session, never from `FormData`.
- **Errors.** Server actions return generic client messages and `console.error` the detail server-side. Never leak a stack trace or a Prisma error to the client.
- **No component tests exist or are possible in this repo.** `vitest.config.ts` sets `environment: "node"` and `include: ["src/**/*.test.ts", "tests/**/*.test.ts"]` — `.tsx` is not matched and there is no jsdom. **Do not add jsdom or a component-test harness.** UI tasks are verified by `npm run lint`, `npm run build`, and the manual checklist in each task. All automated tests go in `.test.ts` files.
- **Tests share one database.** `vitest.config.ts` sets `fileParallelism: false`. Never run `npm test` concurrently with another agent — the suites `TRUNCATE` each other and it looks like flaky failures in unrelated files.
- **Two test idioms — match the one for the layer you are in:**
  - Service tests (`src/modules/**/*.service.test.ts`) hit a **real DB**: `beforeAll(() => migrateTestDb())`, `beforeEach(async () => { await resetDb(); ... })`.
  - Action tests (`src/app/**/*.test.ts`) **mock every dependency** with `vi.mock` and touch no DB.
- **`prisma migrate dev` cannot run in this shell** (it is interactive). Author migrations with `prisma migrate diff --script`, then apply with `prisma migrate deploy`.
- **Migrate before push.** The migration must be applied to the remote DB before the code that queries `Contact` is pushed, or the deploy serves code querying a table that does not exist.
- **Rank is excluded from matching** — it is low-cardinality, so typing `SGT` would return half the book.

---

### Task 1: Contact data layer (schema, migration, service)

**Files:**
- Modify: `prisma/schema.prisma` (add `Contact`; add back-relation to `User`)
- Create: `prisma/migrations/20260715160000_contact_book/migration.sql`
- Modify: `tests/helpers/db.ts:14-16` (add `Contact` to the TRUNCATE list)
- Create: `src/modules/contacts/contacts.schema.ts`
- Create: `src/modules/contacts/contacts.errors.ts`
- Create: `src/modules/contacts/contacts.service.ts`
- Test: `src/modules/contacts/contacts.service.test.ts`

**Interfaces:**
- Consumes: `emailField` from `@/modules/users/users.schema` (already exported); `prisma` from `@/lib/prisma`; `resetDb`/`migrateTestDb` from `tests/helpers/db`.
- Produces:
  - `newContactSchema`, `type NewContactInput = { rank?: string; firstName: string; lastName: string; email: string; unit?: string; contactNumber?: string }`
  - `updateContactSchema`, `type UpdateContactInput = NewContactInput & { id: string }`
  - `class ContactError` with `code: "DUPLICATE_EMAIL" | "NOT_FOUND"`
  - `listContacts(): Promise<Contact[]>`
  - `createContact(input: NewContactInput, createdById: string): Promise<Contact>`
  - `updateContact(input: UpdateContactInput): Promise<Contact>`
  - `deleteContact(id: string): Promise<void>`

- [ ] **Step 1: Add the `Contact` model to `prisma/schema.prisma`**

Append at the end of the file:

```prisma
// A saved recipient for hand receipts — shared org-wide (any signed-in user
// reads it for autofill; only admins write to it). Distinct from User: these are
// outside people who receive equipment and have no login account.
model Contact {
  id String @id @default(cuid())
  rank String?
  // Split (rather than a single free-text `name` like User.name) so ordering by
  // last name is a plain indexed DB sort. Parsing a surname out of one column
  // misfiles "Van Der Berg" and "Doe Jr.". Transfer.receiverName stays a single
  // String; autofill composes "First Last" when filling it.
  firstName String
  lastName  String
  unit          String?
  contactNumber String?
  // citext + unique: one inbox, one contact. Mirrors User.email — the app
  // lowercases on write, so a mixed-case row would otherwise be unfindable by
  // lookups and would not collide with its lowercase twin.
  email String @unique @db.Citext

  // Nullable + SetNull (mirrors ItemEdit.editedBy): the shared book must survive
  // deletion of the account that happened to add a row.
  createdBy   User?   @relation("CreatedContacts", fields: [createdById], references: [id], onDelete: SetNull)
  createdById String?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([lastName, firstName])
}
```

Add this line to the `User` model's relation block (after `signatures Signature[] @relation("UserSignatures")`, around line 44):

```prisma
  createdContacts  Contact[]            @relation("CreatedContacts")
```

- [ ] **Step 2: Generate the migration SQL**

`prisma migrate dev` is interactive and cannot run here. Diff the live DB against the datamodel instead:

```bash
mkdir -p prisma/migrations/20260715160000_contact_book
npx prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma \
  --script > prisma/migrations/20260715160000_contact_book/migration.sql
cat prisma/migrations/20260715160000_contact_book/migration.sql
```

Expected: the file contains a `CREATE TABLE "Contact"`, a unique index on `email`, a `(lastName, firstName)` index, and a `SET NULL` FK — and **nothing else**. If it contains any other table's DDL, the local DB has drifted from the migration history; stop and report rather than committing an unrelated schema change. It should read:

```sql
-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "rank" TEXT,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "unit" TEXT,
    "contactNumber" TEXT,
    "email" CITEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Contact_email_key" ON "Contact"("email");

-- CreateIndex
CREATE INDEX "Contact_lastName_firstName_idx" ON "Contact"("lastName", "firstName");

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

(The `citext` extension already exists — added by `20260714234429_user_email_citext`.)

- [ ] **Step 3: Apply the migration and regenerate the client**

```bash
npx prisma migrate deploy
npx prisma generate
```

Expected: `migrate deploy` reports `1 migration found` and applies `20260715160000_contact_book`; `generate` succeeds.

- [ ] **Step 4: Add `Contact` to the test-DB truncate list**

In `tests/helpers/db.ts`, replace the `$executeRawUnsafe` call:

```ts
  // Contact is listed explicitly rather than relying on its FK to User to pull
  // it in via CASCADE — a contact with a null createdById must be cleared too.
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "Contact","Transfer","Item","User","Unit" RESTART IDENTITY CASCADE;`
  );
```

- [ ] **Step 5: Write `contacts.errors.ts`**

Mirrors `signatures.errors.ts`:

```ts
export class ContactError extends Error {
  constructor(public code: "DUPLICATE_EMAIL" | "NOT_FOUND", message?: string) {
    super(message ?? code);
    this.name = "ContactError";
  }
}
```

- [ ] **Step 6: Write `contacts.schema.ts`**

```ts
import { z } from "zod";
import { emailField } from "@/modules/users/users.schema";

// emailField is imported, not redefined: it is the canonical trim+lowercase
// transform, and it MUST agree with the citext column or the unique constraint
// and our lookups would disagree about identity.

// Blank/whitespace collapses to undefined (→ NULL). Mirrors users.schema.
const optionalText = z
  .string()
  .trim()
  .transform((v) => v || undefined)
  .optional();

const rank = z
  .string()
  .trim()
  .max(20)
  .transform((v) => v || undefined)
  .optional();

export const newContactSchema = z.object({
  rank,
  firstName: z.string().trim().min(1, "First name is required"),
  lastName: z.string().trim().min(1, "Last name is required"),
  email: emailField,
  unit: optionalText,
  contactNumber: optionalText,
});
export type NewContactInput = z.infer<typeof newContactSchema>;

export const updateContactSchema = newContactSchema.extend({
  id: z.string().min(1),
});
export type UpdateContactInput = z.infer<typeof updateContactSchema>;
```

- [ ] **Step 7: Write the failing service test**

Create `src/modules/contacts/contacts.service.test.ts`:

```ts
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
```

- [ ] **Step 8: Run the test to verify it fails**

```bash
npx vitest run src/modules/contacts/contacts.service.test.ts
```

Expected: FAIL — cannot resolve `./contacts.service`.

- [ ] **Step 9: Write `contacts.service.ts`**

```ts
import type { Contact } from "@prisma/client";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import {
  newContactSchema,
  updateContactSchema,
  type NewContactInput,
  type UpdateContactInput,
} from "./contacts.schema";
import { ContactError } from "./contacts.errors";

// The book is shared org-wide: reads are unscoped by design. Write authorization
// is enforced at the action layer (requireAdmin), not here.

export function listContacts(): Promise<Contact[]> {
  return prisma.contact.findMany({ orderBy: [{ lastName: "asc" }, { firstName: "asc" }] });
}

// P2002 = unique violation on `email` — a contact already owns that inbox.
function asDuplicate(e: unknown): never {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
    throw new ContactError("DUPLICATE_EMAIL");
  }
  throw e;
}

export async function createContact(input: NewContactInput, createdById: string): Promise<Contact> {
  const data = newContactSchema.parse(input);
  try {
    return await prisma.contact.create({ data: { ...data, createdById } });
  } catch (e) {
    asDuplicate(e);
  }
}

export async function updateContact(input: UpdateContactInput): Promise<Contact> {
  const { id, ...data } = updateContactSchema.parse(input);
  try {
    return await prisma.contact.update({ where: { id }, data });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
      throw new ContactError("NOT_FOUND");
    }
    asDuplicate(e);
  }
}

export async function deleteContact(id: string): Promise<void> {
  // deleteMany (not delete) so a missing id is a count of 0 rather than a raw
  // Prisma throw, matching signatures.service.deleteSignature.
  const { count } = await prisma.contact.deleteMany({ where: { id } });
  if (count === 0) throw new ContactError("NOT_FOUND");
}
```

Note: `undefined` optionals are written as SQL NULL by Prisma on create. On `update`, an omitted key means "leave unchanged" — but `newContactSchema` always produces every key (present-or-`undefined`), and Prisma treats an explicit `undefined` as "skip". If a test shows a cleared optional not persisting on update, map `undefined` → `null` explicitly in `updateContact`'s `data`.

- [ ] **Step 10: Run the test to verify it passes**

```bash
npx vitest run src/modules/contacts/contacts.service.test.ts
```

Expected: PASS — 9 tests.

- [ ] **Step 11: Lint and commit**

```bash
npm run lint
git add prisma/schema.prisma prisma/migrations/20260715160000_contact_book tests/helpers/db.ts src/modules/contacts
git commit -m "feat(contacts): shared contact book data layer

Contact is split firstName/lastName so last-name ordering is an indexed
DB sort rather than a surname-parsing heuristic that misfiles multi-word
names. citext + unique email dedupes case-insensitively, matching User.
createdBy is SetNull so the shared book outlives the account that added a
row.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `matchContacts` — the pure matching function

**Files:**
- Create: `src/modules/contacts/contact-match.ts`
- Test: `src/modules/contacts/contact-match.test.ts`

**Interfaces:**
- Consumes: nothing. **No Prisma import, no React import** — this must stay pure so it tests in milliseconds and remains the seam to move behind a server action if the book ever outgrows shipping.
- Produces:
  - `type ContactOption = { id: string; rank: string | null; firstName: string; lastName: string; unit: string | null; contactNumber: string | null; email: string }`
  - `matchContacts(contacts: ContactOption[], query: string, limit?: number): ContactOption[]`

- [ ] **Step 1: Write the failing test**

Create `src/modules/contacts/contact-match.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { matchContacts, type ContactOption } from "./contact-match";

function c(over: Partial<ContactOption> & { id: string }): ContactOption {
  return {
    rank: null, firstName: "Jane", lastName: "Doe",
    unit: null, contactNumber: null, email: `${over.id}@unit.mil`,
    ...over,
  };
}

// Ordered by last name, as listContacts() returns them.
const BOOK: ContactOption[] = [
  c({ id: "1", firstName: "Zoe", lastName: "Alvarez", unit: "A Co", rank: "SGT" }),
  c({ id: "2", firstName: "Jane", lastName: "Doe", unit: "B Co", rank: "SGT", email: "jane.doe@unit.mil" }),
  c({ id: "3", firstName: "Bob", lastName: "Smith", unit: "A Co", rank: "CPL" }),
];

describe("matchContacts", () => {
  it("returns nothing for a blank or whitespace query", () => {
    expect(matchContacts(BOOK, "")).toEqual([]);
    expect(matchContacts(BOOK, "   ")).toEqual([]);
  });

  it("matches on first name", () => {
    expect(matchContacts(BOOK, "zoe").map((x) => x.id)).toEqual(["1"]);
  });

  it("matches on last name", () => {
    expect(matchContacts(BOOK, "smith").map((x) => x.id)).toEqual(["3"]);
  });

  it("matches a full name typed as 'first last'", () => {
    expect(matchContacts(BOOK, "jane doe").map((x) => x.id)).toEqual(["2"]);
  });

  it("matches a full name typed as 'last first'", () => {
    expect(matchContacts(BOOK, "doe jane").map((x) => x.id)).toEqual(["2"]);
  });

  it("matches on email", () => {
    expect(matchContacts(BOOK, "jane.doe@").map((x) => x.id)).toEqual(["2"]);
  });

  it("matches on unit", () => {
    expect(matchContacts(BOOK, "a co").map((x) => x.id)).toEqual(["1", "3"]);
  });

  it("is case-insensitive on both sides", () => {
    expect(matchContacts(BOOK, "ZoE").map((x) => x.id)).toEqual(["1"]);
    expect(matchContacts(BOOK, "  SMITH  ").map((x) => x.id)).toEqual(["3"]);
  });

  it("does NOT match on rank — it would return half the book", () => {
    expect(matchContacts(BOOK, "SGT")).toEqual([]);
  });

  it("does not match across field boundaries", () => {
    // "doe" (last of #2) + "bob" (first of #3) must not fuse into a hit.
    expect(matchContacts(BOOK, "doe bob")).toEqual([]);
  });

  it("tolerates null unit without matching everything", () => {
    const withNull = [c({ id: "9", unit: null })];
    expect(matchContacts(withNull, "a co")).toEqual([]);
  });

  it("preserves the input (last-name) order of the book", () => {
    expect(matchContacts(BOOK, "co").map((x) => x.id)).toEqual(["1", "2", "3"]);
  });

  it("caps results at the limit", () => {
    const many = Array.from({ length: 20 }, (_, i) => c({ id: `x${i}`, lastName: "Same" }));
    expect(matchContacts(many, "same")).toHaveLength(8);
    expect(matchContacts(many, "same", 3)).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/modules/contacts/contact-match.test.ts
```

Expected: FAIL — cannot resolve `./contact-match`.

- [ ] **Step 3: Write `contact-match.ts`**

```ts
// Pure: no Prisma, no React, no I/O. The whole book ships to the client with the
// builder page, so matching is a synchronous pass over a few hundred rows —
// which is why the builder needs no debounce, no request race guard, and no
// stale-response handling. Keep this module dependency-free: it is also the seam
// to move behind a server action if the book ever outgrows shipping.

export type ContactOption = {
  id: string;
  rank: string | null;
  firstName: string;
  lastName: string;
  unit: string | null;
  contactNumber: string | null;
  email: string;
};

const MAX_RESULTS = 8;

// Fields joined by "\n" so a query can never match across a field boundary
// ("doe bob" must not fuse one contact's surname to another's given name).
// Both name orders are included so "jane doe" and "doe jane" both hit.
// Rank is deliberately absent: it is low-cardinality, so "SGT" would match half
// the book and bury the contact the user is actually typing toward.
function haystack(c: ContactOption): string {
  return [
    `${c.firstName} ${c.lastName}`,
    `${c.lastName} ${c.firstName}`,
    c.email,
    c.unit ?? "",
  ]
    .join("\n")
    .toLowerCase();
}

/** Contacts whose name, email, or unit contains `query`, in input order. */
export function matchContacts(
  contacts: ContactOption[],
  query: string,
  limit: number = MAX_RESULTS
): ContactOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const out: ContactOption[] = [];
  for (const c of contacts) {
    if (!haystack(c).includes(q)) continue;
    out.push(c);
    if (out.length === limit) break;
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run src/modules/contacts/contact-match.test.ts
```

Expected: PASS — 13 tests.

- [ ] **Step 5: Commit**

```bash
npm run lint
git add src/modules/contacts/contact-match.ts src/modules/contacts/contact-match.test.ts
git commit -m "feat(contacts): pure matchContacts over name, email, and unit

Fields are joined by a newline so a query cannot fuse one contact's
surname to another's given name. Rank is excluded: it is low-cardinality,
so 'SGT' would match half the book.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Admin server actions

**Files:**
- Create: `src/app/admin/actions/contacts.ts`
- Test: `src/app/admin/actions/contacts.test.ts`

**Interfaces:**
- Consumes: `requireAdmin` from `@/lib/authz`; `createContact`/`updateContact`/`deleteContact` from `@/modules/contacts/contacts.service`; `newContactSchema`/`updateContactSchema` from `@/modules/contacts/contacts.schema`; `ContactError` from `@/modules/contacts/contacts.errors`.
- Produces:
  - `createContactAction(_prev: unknown, formData: FormData): Promise<{ error: string } | { ok: true }>` (for `useActionState`)
  - `updateContactAction(_prev: unknown, formData: FormData): Promise<{ error: string } | { ok: true }>` (for `useActionState`)
  - `deleteContactAction(formData: FormData): Promise<void>` (plain form action, like `toggleUserActiveAction`)

- [ ] **Step 1: Write the failing test**

Create `src/app/admin/actions/contacts.test.ts`. This mirrors the mock idiom in `src/app/actions/search.test.ts` — no DB:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const requireAdmin = vi.fn();
const createContact = vi.fn();
const updateContact = vi.fn();
const deleteContact = vi.fn();
const revalidatePath = vi.fn();

class ContactError extends Error {
  constructor(public code: "DUPLICATE_EMAIL" | "NOT_FOUND") {
    super(code);
    this.name = "ContactError";
  }
}

vi.mock("@/lib/authz", () => ({ requireAdmin: () => requireAdmin() }));
vi.mock("@/modules/contacts/contacts.service", () => ({
  createContact: (i: unknown, by: string) => createContact(i, by),
  updateContact: (i: unknown) => updateContact(i),
  deleteContact: (id: string) => deleteContact(id),
}));
vi.mock("@/modules/contacts/contacts.errors", () => ({ ContactError }));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));

import { createContactAction, updateContactAction, deleteContactAction } from "./contacts";

const ADMIN = { id: "admin-1", role: "ADMIN" as const, name: "Admin", email: "a@x.mil" };

function fd(over: Record<string, string> = {}) {
  const f = new FormData();
  f.set("firstName", "Jane");
  f.set("lastName", "Doe");
  f.set("email", "jane@unit.mil");
  for (const [k, v] of Object.entries(over)) f.set(k, v);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAdmin.mockResolvedValue(ADMIN);
  createContact.mockResolvedValue({ id: "c1" });
  updateContact.mockResolvedValue({ id: "c1" });
  deleteContact.mockResolvedValue(undefined);
});

describe("createContactAction", () => {
  it("checks admin before touching the service", async () => {
    requireAdmin.mockRejectedValue(new Error("FORBIDDEN"));
    await expect(createContactAction(undefined, fd())).rejects.toThrow("FORBIDDEN");
    expect(createContact).not.toHaveBeenCalled();
  });

  it("takes createdById from the session, never from the form", async () => {
    await createContactAction(undefined, fd({ createdById: "attacker" }));
    expect(createContact).toHaveBeenCalledWith(expect.anything(), "admin-1");
  });

  it("rejects invalid input without calling the service", async () => {
    const res = await createContactAction(undefined, fd({ email: "not-an-email" }));
    expect(res).toHaveProperty("error");
    expect(createContact).not.toHaveBeenCalled();
  });

  it("rejects a missing last name", async () => {
    const res = await createContactAction(undefined, fd({ lastName: "  " }));
    expect(res).toEqual({ error: "Last name is required" });
  });

  it("maps a duplicate email to a friendly message", async () => {
    createContact.mockRejectedValue(new ContactError("DUPLICATE_EMAIL"));
    expect(await createContactAction(undefined, fd()))
      .toEqual({ error: "A contact with that email already exists." });
  });

  it("returns a generic message and does not leak an unexpected error", async () => {
    createContact.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.1:5432"));
    const res = await createContactAction(undefined, fd());
    expect(res).toEqual({ error: "Something went wrong." });
    expect(JSON.stringify(res)).not.toContain("ECONNREFUSED");
  });

  it("revalidates the users page on success", async () => {
    expect(await createContactAction(undefined, fd())).toEqual({ ok: true });
    expect(revalidatePath).toHaveBeenCalledWith("/admin/users");
  });
});

describe("updateContactAction", () => {
  it("checks admin first", async () => {
    requireAdmin.mockRejectedValue(new Error("FORBIDDEN"));
    await expect(updateContactAction(undefined, fd({ id: "c1" }))).rejects.toThrow("FORBIDDEN");
    expect(updateContact).not.toHaveBeenCalled();
  });

  it("requires an id", async () => {
    const res = await updateContactAction(undefined, fd());
    expect(res).toHaveProperty("error");
    expect(updateContact).not.toHaveBeenCalled();
  });

  it("maps a duplicate email to a friendly message", async () => {
    updateContact.mockRejectedValue(new ContactError("DUPLICATE_EMAIL"));
    expect(await updateContactAction(undefined, fd({ id: "c1" })))
      .toEqual({ error: "A contact with that email already exists." });
  });

  it("revalidates on success", async () => {
    expect(await updateContactAction(undefined, fd({ id: "c1" }))).toEqual({ ok: true });
    expect(revalidatePath).toHaveBeenCalledWith("/admin/users");
  });
});

describe("deleteContactAction", () => {
  it("checks admin first", async () => {
    requireAdmin.mockRejectedValue(new Error("FORBIDDEN"));
    const f = new FormData();
    f.set("id", "c1");
    await expect(deleteContactAction(f)).rejects.toThrow("FORBIDDEN");
    expect(deleteContact).not.toHaveBeenCalled();
  });

  it("deletes and revalidates", async () => {
    const f = new FormData();
    f.set("id", "c1");
    await deleteContactAction(f);
    expect(deleteContact).toHaveBeenCalledWith("c1");
    expect(revalidatePath).toHaveBeenCalledWith("/admin/users");
  });

  it("swallows a NOT_FOUND so a double-submit does not 500", async () => {
    deleteContact.mockRejectedValue(new ContactError("NOT_FOUND"));
    const f = new FormData();
    f.set("id", "gone");
    await expect(deleteContactAction(f)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/app/admin/actions/contacts.test.ts
```

Expected: FAIL — cannot resolve `./contacts`.

- [ ] **Step 3: Write `src/app/admin/actions/contacts.ts`**

```ts
"use server";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/authz";
import { createContact, updateContact, deleteContact } from "@/modules/contacts/contacts.service";
import { newContactSchema, updateContactSchema } from "@/modules/contacts/contacts.schema";
import { ContactError } from "@/modules/contacts/contacts.errors";

// Mirrors admin/actions/users.ts: requireAdmin first, zod-parse the form, return
// a generic message to the client and log the detail server-side.
//
// Only /admin/users is revalidated. /receipts/new reads the book too, but it is
// dynamically rendered (it awaits auth() and searchParams), so it re-queries on
// every request and has no cache entry to bust.

const DUPLICATE = "A contact with that email already exists.";
const GENERIC = "Something went wrong.";

export async function createContactAction(_prev: unknown, formData: FormData) {
  const admin = await requireAdmin();
  const parsed = newContactSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  try {
    // createdById comes from the verified session — never from the form.
    await createContact(parsed.data, admin.id);
  } catch (e) {
    if (e instanceof ContactError && e.code === "DUPLICATE_EMAIL") return { error: DUPLICATE };
    console.error("[createContactAction] failed:", e);
    return { error: GENERIC };
  }
  revalidatePath("/admin/users");
  return { ok: true as const };
}

export async function updateContactAction(_prev: unknown, formData: FormData) {
  await requireAdmin();
  const parsed = updateContactSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  try {
    await updateContact(parsed.data);
  } catch (e) {
    if (e instanceof ContactError && e.code === "DUPLICATE_EMAIL") return { error: DUPLICATE };
    if (e instanceof ContactError && e.code === "NOT_FOUND") return { error: "That contact no longer exists." };
    console.error("[updateContactAction] failed:", e);
    return { error: GENERIC };
  }
  revalidatePath("/admin/users");
  return { ok: true as const };
}

export async function deleteContactAction(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id"));
  try {
    await deleteContact(id);
  } catch (e) {
    // Already gone (e.g. a double-submit or two admins deleting at once) is the
    // outcome the user wanted — don't turn it into a 500.
    if (!(e instanceof ContactError && e.code === "NOT_FOUND")) {
      console.error("[deleteContactAction] failed:", e);
      throw e;
    }
  }
  revalidatePath("/admin/users");
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run src/app/admin/actions/contacts.test.ts
```

Expected: PASS — 14 tests.

- [ ] **Step 5: Run the full suite and commit**

Confirm no other agent is running tests first (the suites share one DB and TRUNCATE each other).

```bash
npm test
npm run lint
git add src/app/admin/actions/contacts.ts src/app/admin/actions/contacts.test.ts
git commit -m "feat(contacts): admin-only server actions for the contact book

createdById is taken from the verified session, never the form. A
NOT_FOUND delete is swallowed: already-gone is the outcome the user
wanted, so a double-submit should not 500.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Contact book UI on the Users page

**Files:**
- Create: `src/app/admin/users/ContactBookSection.tsx`
- Modify: `src/app/admin/users/page.tsx` (import `listContacts` + render the section)

**Interfaces:**
- Consumes: `createContactAction`/`updateContactAction`/`deleteContactAction` from `@/app/admin/actions/contacts`; `listContacts` from `@/modules/contacts/contacts.service`; `RANK_OPTIONS` from `@/lib/ranks`; `PhoneInput` from `@/components/PhoneInput`; **`type ContactOption` from `@/modules/contacts/contact-match` (Task 2)**.
- Produces: `<ContactBookSection contacts={ContactOption[]} />`.

**Do not define a second row type.** `ContactOption` (Task 2) is already exactly the client-facing contact shape; a parallel `ContactRow` would be the same seven fields under a different name and would drift. Importing a type from the module that owns it matches the existing convention (`PickableSignature` is imported from `TechnicianSignatureField`).

**Note:** There is no component-test harness in this repo (see Global Constraints). Verification is `npm run lint`, `npm run build`, and the manual checklist in Step 4.

- [ ] **Step 1: Write `ContactBookSection.tsx`**

```tsx
"use client";
import { useActionState, useEffect, useState } from "react";
import { createContactAction, updateContactAction, deleteContactAction } from "@/app/admin/actions/contacts";
import { RANK_OPTIONS } from "@/lib/ranks";
import { PhoneInput } from "@/components/PhoneInput";
import type { ContactOption } from "@/modules/contacts/contact-match";

// The add and edit forms take the same fields; `contact` seeds the edit case.
// `idPrefix` keeps label/input ids unique when an edit row renders alongside the
// add form.
function ContactFields({ idPrefix, contact }: { idPrefix: string; contact?: ContactOption }) {
  return (
    <div className="form-grid">
      <div className="field">
        <label className="label" htmlFor={`${idPrefix}-rank`}>Rank</label>
        <input
          id={`${idPrefix}-rank`} className="input" name="rank" list={`${idPrefix}-ranks`}
          defaultValue={contact?.rank ?? ""} placeholder="e.g. SGT (optional)" autoComplete="off"
        />
        <datalist id={`${idPrefix}-ranks`}>
          {RANK_OPTIONS.map((r) => <option key={r} value={r} />)}
        </datalist>
      </div>
      <div className="field">
        <label className="label" htmlFor={`${idPrefix}-first`}>First name</label>
        <input id={`${idPrefix}-first`} className="input" name="firstName" defaultValue={contact?.firstName ?? ""} placeholder="Jane" required />
      </div>
      <div className="field">
        <label className="label" htmlFor={`${idPrefix}-last`}>Last name</label>
        <input id={`${idPrefix}-last`} className="input" name="lastName" defaultValue={contact?.lastName ?? ""} placeholder="Doe" required />
      </div>
      <div className="field">
        <label className="label" htmlFor={`${idPrefix}-email`}>Email</label>
        <input id={`${idPrefix}-email`} className="input" name="email" type="email" defaultValue={contact?.email ?? ""} placeholder="jane@unit.mil" required />
      </div>
      <div className="field">
        <label className="label" htmlFor={`${idPrefix}-unit`}>Unit</label>
        <input id={`${idPrefix}-unit`} className="input" name="unit" defaultValue={contact?.unit ?? ""} placeholder="e.g. A Co, 1-1 IN (optional)" />
      </div>
      <div className="field">
        <label className="label" htmlFor={`${idPrefix}-contact`}>Contact number</label>
        <PhoneInput id={`${idPrefix}-contact`} name="contactNumber" defaultValue={contact?.contactNumber ?? undefined} />
      </div>
    </div>
  );
}

function NewContactForm() {
  const [state, action, pending] = useActionState(createContactAction, undefined);
  return (
    <form action={action} className="stack-sm">
      <ContactFields idPrefix="nc" />
      <div className="row">
        <button disabled={pending} type="submit" className="btn btn-primary">
          {pending ? "Adding…" : "Add contact"}
        </button>
        {state && "error" in state && state.error && <span role="alert" className="alert-error">{state.error}</span>}
        {state && "ok" in state && state.ok && <span className="alert-success">Contact saved.</span>}
      </div>
    </form>
  );
}

function EditContactForm({ contact, onDone }: { contact: ContactOption; onDone: () => void }) {
  const [state, action, pending] = useActionState(updateContactAction, undefined);
  // Close the row once the server confirms the write. This MUST be an effect,
  // not a bare `if (ok) onDone()` in the render body — that would set the parent's
  // state while rendering a child, which React rejects.
  const ok = state !== undefined && "ok" in state && state.ok;
  useEffect(() => {
    if (ok) onDone();
  }, [ok, onDone]);
  return (
    <form action={action} className="stack-sm">
      <input type="hidden" name="id" value={contact.id} />
      <ContactFields idPrefix={`ec-${contact.id}`} contact={contact} />
      <div className="row">
        <button disabled={pending} type="submit" className="btn btn-primary btn-sm">
          {pending ? "Saving…" : "Save"}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onDone}>Cancel</button>
        {state && "error" in state && state.error && <span role="alert" className="alert-error">{state.error}</span>}
      </div>
    </form>
  );
}

export function ContactBookSection({ contacts }: { contacts: ContactOption[] }) {
  // One row editable at a time — an inline form per row would multiply
  // useActionState instances for no benefit.
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <div className="stack">
      <div className="card">
        <div className="card__title">Add a contact</div>
        <p className="subtle">
          Saved recipients are shared with everyone and autofill the recipient
          fields on a new hand receipt.
        </p>
        <NewContactForm />
      </div>

      {contacts.length === 0 ? (
        <div className="card empty">No saved contacts yet.</div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Unit</th>
                <th>Contact number</th>
                <th style={{ textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {contacts.map((c) =>
                editingId === c.id ? (
                  <tr key={c.id}>
                    <td colSpan={5} data-label="">
                      <EditContactForm contact={c} onDone={() => setEditingId(null)} />
                    </td>
                  </tr>
                ) : (
                  <tr key={c.id}>
                    <td data-label="Name">
                      {c.rank ? `${c.rank} ` : ""}
                      <strong>{c.lastName}, {c.firstName}</strong>
                    </td>
                    <td className="mono" data-label="Email">{c.email}</td>
                    <td data-label="Unit">{c.unit ?? <span className="subtle">—</span>}</td>
                    <td data-label="Contact number">{c.contactNumber ?? <span className="subtle">—</span>}</td>
                    <td data-label="">
                      <div className="actions" style={{ justifyContent: "flex-end" }}>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditingId(c.id)}>
                          Edit
                        </button>
                        <form action={deleteContactAction}>
                          <input type="hidden" name="id" value={c.id} />
                          <button type="submit" className="btn btn-danger btn-sm">Delete</button>
                        </form>
                      </div>
                    </td>
                  </tr>
                )
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Wire it into `src/app/admin/users/page.tsx`**

Add the imports:

```tsx
import { listContacts } from "@/modules/contacts/contacts.service";
import { ContactBookSection } from "./ContactBookSection";
```

Replace the single `const users = await listUsers();` (line 15) with a parallel load — the two queries are independent, so serializing them would add a round-trip for nothing:

```tsx
  const [users, contacts] = await Promise.all([listUsers(), listContacts()]);
```

Then append this section at the end of the outer `<div className="stack">`, after the closing `</div>` of the users `table-wrap`:

```tsx
      <div>
        <h2 className="page-title">Contact book</h2>
        <p className="subtle">Saved recipients, ordered by last name.</p>
      </div>
      <ContactBookSection
        contacts={contacts.map((c) => ({
          id: c.id,
          rank: c.rank,
          firstName: c.firstName,
          lastName: c.lastName,
          unit: c.unit,
          contactNumber: c.contactNumber,
          email: c.email,
        }))}
      />
```

The explicit field mapping (rather than passing `contacts` straight through) keeps `createdById` and the timestamps out of the RSC payload.

- [ ] **Step 3: Verify it builds and lints**

```bash
npm run lint
npm run build
```

Expected: both succeed with no new warnings.

- [ ] **Step 4: Manual verification**

Run `npm run dev`, sign in as an admin, and open `/admin/users`:

1. The "Contact book" section renders below the users table with an empty state.
2. Add `SGT` / `Jane` / `Doe` / `jane@unit.mil` / `A Co` / a phone number → the row appears as **`SGT Doe, Jane`**.
3. Add a second contact `Alvarez, Zoe` → it sorts **above** Doe (last-name order).
4. Add a contact reusing `jane@unit.mil` → the inline error reads "A contact with that email already exists."
5. Try `JANE@UNIT.MIL` → same duplicate error (citext).
6. Edit → the row becomes a seeded form; Save persists; Cancel restores the row unchanged.
7. Delete → the row disappears.
8. Sign in as a non-admin and open `/admin/users` → still redirected to `/` (the existing gate is untouched).

- [ ] **Step 5: Commit**

```bash
git add src/app/admin/users/ContactBookSection.tsx src/app/admin/users/page.tsx
git commit -m "feat(contacts): manage the shared contact book on the Users page

Contacts load alongside users in a Promise.all — independent queries, no
reason to serialize them. Rows are mapped explicitly so createdById and
timestamps stay out of the RSC payload.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: `PhoneInput` optional controlled mode

**Files:**
- Modify: `src/components/PhoneInput.tsx`

**Interfaces:**
- Produces: `PhoneInput` accepting `value?: string` and `onChange?: (v: string) => void`. Passing `value` opts into controlled mode; omitting it preserves today's uncontrolled behavior exactly.

**Why:** `PhoneInput` seeds its state **once** from `defaultValue` via a lazy `useState` initializer, so it owns its value. Autofill cannot drive it — pushing a new `defaultValue` after mount does nothing. Task 7 needs to set the number from outside when a contact is picked.

**Why optional rather than fully controlled:** all three existing callers (`register/page.tsx:22`, `NewUserForm.tsx:33`, `ReceiptBuilderForm.tsx:48`) rely on the uncontrolled behavior. An optional mode is additive and leaves them untouched.

- [ ] **Step 1: Rewrite `src/components/PhoneInput.tsx`**

```tsx
"use client";
import { useState } from "react";
import { formatPhone } from "@/lib/phone";

// Phone input that auto-formats to (xxx)-xxx-xxxx as the user types.
//
// Uncontrolled by default: state is seeded once from `defaultValue`, which is
// what the register and new-user forms want. Passing `value` opts into
// controlled mode — the receipt builder needs that so picking a contact can set
// the number from outside, which a defaultValue-seeded useState cannot do.
export function PhoneInput({
  name,
  id,
  defaultValue,
  value,
  onChange,
  required,
  placeholder = "(123)-456-7890",
}: {
  name: string;
  id?: string;
  defaultValue?: string;
  value?: string;
  onChange?: (v: string) => void;
  required?: boolean;
  placeholder?: string;
}) {
  const [inner, setInner] = useState(() => formatPhone(defaultValue ?? ""));
  const controlled = value !== undefined;
  const shown = controlled ? formatPhone(value) : inner;

  return (
    <input
      id={id}
      name={name}
      className="input"
      type="tel"
      inputMode="numeric"
      autoComplete="tel"
      placeholder={placeholder}
      value={shown}
      onChange={(e) => {
        const next = formatPhone(e.target.value);
        if (controlled) onChange?.(next);
        else setInner(next);
      }}
      required={required}
    />
  );
}
```

- [ ] **Step 2: Verify it builds and lints**

```bash
npm run lint
npm run build
```

Expected: both succeed.

- [ ] **Step 3: Manual regression check on all three existing callers**

The change touches a shared component, so confirm the untouched callers still behave. Run `npm run dev` and check:

1. `/register` → typing `5551234567` in Contact number formats to `(555)-123-4567`.
2. `/admin/users` → "Add a user" contact number formats the same way; the Add-a-contact field from Task 4 also still formats.
3. `/receipts/new?items=<id>` → the sender's Contact number is still prefilled from the last receiver (when one exists) and is still editable.

- [ ] **Step 4: Commit**

```bash
git add src/components/PhoneInput.tsx
git commit -m "feat(phone): optional controlled mode on PhoneInput

State is seeded once from defaultValue, so a later defaultValue change is
ignored and autofill cannot drive the field. Passing \`value\` opts into
controlled mode; the three existing callers keep the uncontrolled path.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: `ContactCombobox`

**Files:**
- Create: `src/components/ContactCombobox.tsx`
- Modify: `src/app/globals.css:602` (add an `.sr-only` utility after `.mono`)

**Interfaces:**
- Consumes: `matchContacts`, `type ContactOption` from `@/modules/contacts/contact-match`.
- Produces:
  ```ts
  <ContactCombobox
    id?: string
    name: string                          // posted field name, e.g. "receiverName"
    contacts: ContactOption[]
    value: string
    onValueChange: (v: string) => void    // free typing
    onPick: (c: ContactOption) => void    // a contact was chosen
  />
  ```

**Note:** no component-test harness exists (see Global Constraints); verification is lint, build, and the manual checklist in Task 7 Step 4.

- [ ] **Step 1: Add the `.sr-only` utility to `src/app/globals.css`**

Insert directly after the `.mono` rule (which ends at line 602), before the `/* ---------- Badges ---------- */` comment:

```css
/* Visible to assistive tech only — used for live-region announcements that
   would be redundant on screen (e.g. the contact combobox result count). */
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
```

- [ ] **Step 2: Write `src/components/ContactCombobox.tsx`**

```tsx
"use client";
import { useId, useMemo, useRef, useState } from "react";
import { matchContacts, type ContactOption } from "@/modules/contacts/contact-match";

// A type-ahead over the contact book that also IS the name field — the posted
// `name` input is the combobox input itself, so a receipt can still be filled by
// typing a recipient who isn't in the book.
//
// The whole book arrives with the page (see receipts/new/page.tsx), so filtering
// is synchronous and local: no fetch per keystroke, and therefore no debounce,
// no request race guard, and no stale-response handling to get wrong.
export function ContactCombobox({
  id,
  name,
  contacts,
  value,
  onValueChange,
  onPick,
}: {
  id?: string;
  name: string;
  contacts: ContactOption[];
  value: string;
  onValueChange: (v: string) => void;
  onPick: (c: ContactOption) => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const matches = useMemo(() => matchContacts(contacts, value), [contacts, value]);
  const show = open && matches.length > 0;
  // Clamp: `matches` can shrink under a stale `active` between renders.
  const activeIndex = Math.min(active, Math.max(matches.length - 1, 0));

  const pick = (c: ContactOption) => {
    onPick(c);
    setOpen(false);
    setActive(0);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!show) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (Math.min(i, matches.length - 1) + 1) % matches.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (Math.min(i, matches.length - 1) - 1 + matches.length) % matches.length);
    } else if (e.key === "Enter") {
      // Only swallow Enter while a suggestion is highlighted, so Enter otherwise
      // still submits the form as usual.
      e.preventDefault();
      pick(matches[activeIndex]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div style={{ position: "relative" }}>
      <input
        id={id}
        className="input"
        name={name}
        role="combobox"
        aria-expanded={show}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={show ? `${listId}-${activeIndex}` : undefined}
        autoComplete="off"
        value={value}
        onChange={(e) => {
          onValueChange(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        // Deferred: a click on an option fires after blur, so closing
        // immediately would unmount the option before it registers.
        onBlur={() => {
          blurTimer.current = setTimeout(() => setOpen(false), 120);
        }}
        onKeyDown={onKeyDown}
        required
      />

      {show && (
        <ul
          id={listId}
          role="listbox"
          className="card"
          style={{
            position: "absolute", zIndex: 20, insetInlineStart: 0, insetInlineEnd: 0,
            marginBlockStart: 4, maxHeight: 260, overflowY: "auto", padding: 4, listStyle: "none",
          }}
          // Cancel the deferred close: mousedown beats blur, so the click lands.
          onMouseDown={() => {
            if (blurTimer.current) clearTimeout(blurTimer.current);
          }}
        >
          {matches.map((c, i) => (
            <li
              key={c.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === activeIndex}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(c)}
              style={{
                padding: "6px 8px", cursor: "pointer", borderRadius: "var(--radius-sm)",
                background: i === activeIndex ? "var(--surface-2)" : undefined,
              }}
            >
              <div>
                <strong>{c.lastName}, {c.firstName}</strong>
                {c.rank ? <span className="subtle"> · {c.rank}</span> : null}
              </div>
              <div className="subtle">{c.email}{c.unit ? ` · ${c.unit}` : ""}</div>
            </li>
          ))}
        </ul>
      )}

      {/* The list is visible, so this is for screen readers only. Mirrors the
          aria-live idiom in HomeSearch.tsx. */}
      <div aria-live="polite" role="status" className="sr-only">
        {show ? `${matches.length} contact${matches.length === 1 ? "" : "s"} available.` : ""}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verify it builds and lints**

```bash
npm run lint
npm run build
```

Expected: both succeed. (The component is not yet rendered anywhere — Task 7 wires it in.)

- [ ] **Step 4: Commit**

```bash
git add src/components/ContactCombobox.tsx src/app/globals.css
git commit -m "feat(contacts): ContactCombobox type-ahead over the shared book

The combobox input IS the posted name field, so a recipient who isn't in
the book can still be typed. Blur-close is deferred and cancelled on
mousedown, otherwise the option unmounts before the click lands.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Wire autofill into the hand-receipt builder

**Files:**
- Modify: `src/app/receipts/new/page.tsx:31-34` (add `listContacts()` to the existing `Promise.all`) and the `<ReceiptBuilderForm>` call
- Modify: `src/app/receipts/new/ReceiptBuilderForm.tsx` (`PartyFields` + the `ReceiptBuilderForm` signature)

**Interfaces:**
- Consumes: `ContactCombobox` from `@/components/ContactCombobox`; `type ContactOption` from `@/modules/contacts/contact-match`; `listContacts` from `@/modules/contacts/contacts.service`.
- Produces: `ReceiptBuilderForm` gains a `contacts: ContactOption[]` prop. The posted field names are **unchanged**, so `createReceiptAction` and its schema need no edit.

- [ ] **Step 1: Load contacts in parallel in `src/app/receipts/new/page.tsx`**

Add the import:

```tsx
import { listContacts } from "@/modules/contacts/contacts.service";
```

Replace the existing `Promise.all` (lines 31-34) — keep the comment block above it intact and add the contacts line:

```tsx
  const [signatures, lastReceivers, contacts] = await Promise.all([
    user.role === "ADMIN" ? listSignatures(user.id) : Promise.resolve([]),
    Promise.all(loaded.map((i) => getLastReceiver(i.id))),
    listContacts(),
  ]);
```

Then pass it to the form, alongside the existing props:

```tsx
            signatures={signatures}
            contacts={contacts.map((c) => ({
              id: c.id,
              rank: c.rank,
              firstName: c.firstName,
              lastName: c.lastName,
              unit: c.unit,
              contactNumber: c.contactNumber,
              email: c.email,
            }))}
```

The book joins the query that already runs here rather than adding a serial round-trip, and the explicit mapping keeps `createdById` and the timestamps out of the RSC payload.

- [ ] **Step 2: Add the autofill to `PartyFields` in `ReceiptBuilderForm.tsx`**

Add the imports at the top:

```tsx
import { ContactCombobox } from "@/components/ContactCombobox";
import type { ContactOption } from "@/modules/contacts/contact-match";
```

Replace the whole `PartyFields` function (lines 13-54) with:

```tsx
function PartyFields({ role, prefill, isDcsim, onIsDcsimChange, hideName, name, onNameChange, contacts }: {
  role: "sender" | "receiver";
  prefill?: Prefill;
  isDcsim: boolean;
  onIsDcsimChange: (v: boolean) => void;
  hideName?: boolean;
  name: string;
  onNameChange: (v: string) => void;
  // Present only for the side that autofills from the contact book (the
  // recipient). Absent on the sender, which keeps its plain name input.
  contacts?: ContactOption[];
}) {
  const cap = role === "sender" ? "Sender" : "Recipient";

  // LIFTED from `defaultValue` (uncontrolled) so picking a contact can drive all
  // four at once — same reasoning as `name` above and ServiceControls' `note`
  // below. Seeded from `prefill`, so the sender side behaves exactly as before.
  const [rank, setRank] = useState(prefill?.rank ?? "");
  const [unit, setUnit] = useState(prefill?.unit ?? "");
  const [contact, setContact] = useState(prefill?.contact ?? "");
  const [email, setEmail] = useState(prefill?.email ?? "");

  // Missing optionals fill as "", leaving the existing `required` validation to
  // prompt: an incomplete contact degrades to a partly-filled form, never a
  // blocked one. Every field stays editable — a pick is a starting point.
  const onPick = (c: ContactOption) => {
    onNameChange(`${c.firstName} ${c.lastName}`);
    setRank(c.rank ?? "");
    setUnit(c.unit ?? "");
    setContact(c.contactNumber ?? "");
    setEmail(c.email);
  };

  // Contacts are outside recipients. A DCSIM party is our own technician — they
  // have an account and a saved-signature picker, and the four fields below
  // aren't even rendered for them — so the book never applies there.
  const showCombobox = contacts !== undefined && !isDcsim;

  return (
    <fieldset className="card stack-sm">
      <legend className="card__title">{cap}</legend>
      <label className="row">
        <input type="checkbox" name={`${role}IsDcsim`} checked={isDcsim} onChange={(e) => onIsDcsimChange(e.target.checked)} />
        This side is DCSIM
      </label>
      {/* Hidden while a saved signature is picked: the name is taken from that
          signature server-side, so an editable field here could only disagree
          with the ink. Not rendered (rather than disabled) so nothing posts.
          The value is LIFTED (like ServiceControls' note below) rather than left
          uncontrolled: hiding unmounts the input, and an uncontrolled one would
          lose whatever was typed, then remount blank. */}
      {!hideName && (
        // Capped: this field is outside .form-grid, so on the wide builder page
        // it would otherwise stretch to the full ~1190px card.
        <div className="field" style={{ maxWidth: 360 }}>
          <label className="label" htmlFor={`${role}-name`}>{isDcsim ? "DCSIM technician name" : "Name"}</label>
          {showCombobox ? (
            <ContactCombobox
              id={`${role}-name`}
              name={`${role}Name`}
              contacts={contacts}
              value={name}
              onValueChange={onNameChange}
              onPick={onPick}
            />
          ) : (
            <input id={`${role}-name`} className="input" name={`${role}Name`} value={name} onChange={(e) => onNameChange(e.target.value)} required />
          )}
        </div>
      )}
      {!isDcsim && (
        <div className="form-grid form-grid-fluid">
          <div className="field"><label className="label">Rank</label><input className="input" name={`${role}Rank`} value={rank} onChange={(e) => setRank(e.target.value)} required /></div>
          <div className="field"><label className="label">Unit</label><input className="input" name={`${role}Unit`} value={unit} onChange={(e) => setUnit(e.target.value)} required /></div>
          <div className="field"><label className="label">Contact number</label><PhoneInput name={`${role}Contact`} value={contact} onChange={setContact} required /></div>
          <div className="field"><label className="label">Email</label><input className="input" type="email" name={`${role}Email`} value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
        </div>
      )}
    </fieldset>
  );
}
```

- [ ] **Step 3: Thread `contacts` through `ReceiptBuilderForm`**

Change the signature (line 114):

```tsx
export function ReceiptBuilderForm({ itemIds, lines, senderPrefill, signatures, contacts }: { itemIds: string[]; lines: BuilderLine[]; senderPrefill?: Prefill; signatures: PickableSignature[]; contacts: ContactOption[] }) {
```

Pass it to the receiver only (line 186) — the sender already prefills from the last receiver, and autofill there is out of scope:

```tsx
      <PartyFields role="receiver" isDcsim={receiverIsDcsim} onIsDcsimChange={onReceiverDcsimChange} hideName={hideReceiverName} name={receiverName} onNameChange={setReceiverName} contacts={contacts} />
```

Leave the sender's `<PartyFields role="sender" ... />` (line 185) unchanged.

- [ ] **Step 4: Verify it builds and lints**

```bash
npm run lint
npm run build
```

Expected: both succeed.

- [ ] **Step 5: Manual verification**

Seed at least two contacts via `/admin/users` (e.g. `Doe, Jane` in `A Co` and `Alvarez, Zoe` in `A Co`). Then open `/receipts/new?items=<an active item id>`:

1. Type `do` in the recipient **Name** → a dropdown lists `Doe, Jane`.
2. Typing stays fluid; no flicker and no network request per keystroke (confirm in the Network tab — there should be **none**).
3. Click `Doe, Jane` → Name, Rank, Unit, Contact number, and Email all fill; the phone number renders formatted.
4. ArrowDown/ArrowUp move the highlight; Enter selects; Escape closes.
5. Type `a co` → **both** contacts list (unit match).
6. Type `sgt` → **no** dropdown (rank is excluded by design).
7. Every autofilled field is still editable afterward.
8. Type a recipient who is **not** in the book, fill the four fields manually, and submit → the receipt is created as before.
9. Check **"This side is DCSIM"** on the recipient → the dropdown and the four fields disappear; the label reads "DCSIM technician name"; the saved-signature picker still works. Uncheck → the fields return.
10. Submit a receipt from a picked contact → the created receipt shows the right recipient, and the PDF renders with those details.

- [ ] **Step 6: Run the full suite and commit**

Confirm no other agent is running tests first.

```bash
npm test
```

Expected: PASS — everything, including the pre-existing `receipts.test.ts` (the posted field names are unchanged, so `createReceiptAction` is unaffected).

```bash
git add src/app/receipts/new/page.tsx src/app/receipts/new/ReceiptBuilderForm.tsx
git commit -m "feat(receipts): autofill the recipient from the contact book

The book joins the Promise.all already running on this page rather than
adding a serial round-trip, then filters in memory per keystroke — so
typing costs no network and needs no debounce or race guard.

PartyFields' four recipient fields move from defaultValue to state so a
pick can drive them; seeded from prefill, the sender is unchanged. The
combobox is recipient-only and non-DCSIM: a DCSIM party is our own
technician, who has an account and a signature picker instead.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Deployment note

Per the spec and the project's deploy rules: apply the migration to the remote database **before** pushing this code. Pushing first serves code that queries a `Contact` table that does not exist yet.

```bash
# with DATABASE_URL pointed at the remote DB
npx prisma migrate deploy
```
