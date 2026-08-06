# Hand Receipt Drafts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a technician save an in-progress hand receipt from the builder, list saved drafts in their account, and resume one where they left off.

**Architecture:** "Save draft" is a second submit button on the *existing* builder form, using `formAction={saveDraft}` + `formNoValidate`, so the browser serializes the same `FormData` the Create button would post. A new owner-scoped `ReceiptDraft` table stores that payload as validated JSON, minus the signature. Resuming loads `/receipts/new?draft=<id>`, filters out items that are no longer transferable, and seeds the form.

**Tech Stack:** Next.js 16 (App Router, Server Components, React 19), TypeScript 5, Prisma 7 over PostgreSQL, Zod, Vitest, Playwright.

## Global Constraints

- **Design spec:** `docs/superpowers/specs/2026-08-06-hand-receipt-drafts-design.md`. Read it before starting.
- **Never persist the recipient signature.** Not in the payload schema, not in the table, not on resume. A resumed draft must be signed again.
- **Every draft query is scoped `where: { ..., userId }`.** Use `deleteMany`/`updateMany`/`findFirst` so the owner scope is part of the WHERE clause, matching `src/modules/signatures/signatures.service.ts`.
- **Every Server Action starts with `requireUser()`** from `@/lib/authz` — never bare `auth()`.
- **Draft limits:** 25 drafts per user; `itemIds` ≤ `MAX_RECEIPT_ROWS * MAX_ITEMS_PER_ROW` (18 × 10 = 180); `lines` ≤ `MAX_RECEIPT_ROWS` (18).
- **Purge window:** 30 days on `updatedAt`.
- **Do NOT add `preflight` or a global CSS reset.** New UI reuses the existing `globals.css` ledger classes (`.card`, `.stack-sm`, `.row`, `.btn`, `.spacer`, `.subtle`, `.alert-error`, `.alert-success`).
- **Do NOT put a layout class on a `<dialog>`.** This feature adds no dialog at all.
- **No `useEffect` for "react to a settled action".** The repo lints that as an error; use the guarded render-time write pattern in `SignatureManager.tsx:28-35`.
- **Docs are part of the change.** Task 10 is not optional — `Security docs current` CI will block the PR without it.
- **`npm test` runs the whole DB-backed suite against a shared test database.** If another agent/session may be running tests concurrently, run single files (`npx vitest run <path>`) rather than the full suite.

---

## Task 1: Data model and migration

**Files:**
- Modify: `prisma/schema.prisma` (add model; add `User` back-relation near line 48)
- Create: `prisma/migrations/<timestamp>_add_receipt_draft/migration.sql`

**Interfaces:**
- Produces: Prisma model `ReceiptDraft` with fields `id`, `userId`, `recipientName`, `itemCount`, `payload`, `createdAt`, `updatedAt`. Client accessor `prisma.receiptDraft`.

- [ ] **Step 1: Add the model to `prisma/schema.prisma`**

Append at the end of the file:

```prisma
// An in-progress hand receipt saved from the builder. PRIVATE to its author —
// a deliberate exception to this app's role-based, org-shared authorization
// (see CLAUDE.md §1): a filed receipt is a shared organizational record, but a
// half-typed form is personal working state.
//
// The recipient signature is deliberately NOT stored. Ink attests to a specific
// item list (ReceiptBuilderForm discards it whenever the list changes), so a
// signature restored onto a since-edited draft would attest to a list it never
// covered.
model ReceiptDraft {
  id     String @id @default(cuid())
  user   User   @relation("ReceiptDrafts", fields: [userId], references: [id], onDelete: Cascade)
  userId String

  // Denormalized from `payload` on every save so the account list never has to
  // deserialize a payload to render a row. Written from the same parsed object,
  // so they cannot drift.
  recipientName String?
  itemCount     Int     @default(0)

  // The builder form's fields, minus the signature. Shape is enforced by
  // receiptDraftSchema on every write AND every read — a Json column is untyped
  // at the DB level, and a payload written by an older deploy must not be able
  // to crash the builder.
  payload Json

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([userId, updatedAt]) // the /account list
  @@index([updatedAt])         // the nightly purge sweep
}
```

- [ ] **Step 2: Add the back-relation to `User`**

In `model User`, alongside the other relation fields (after `publicAccessUpdates`, ~line 48):

```prisma
  receiptDrafts       ReceiptDraft[]        @relation("ReceiptDrafts")
```

- [ ] **Step 3: Generate the migration SQL**

`prisma migrate dev` cannot run in this shell (it needs an interactive TTY). Generate the script instead:

```bash
mkdir -p prisma/migrations/20260806120000_add_receipt_draft
npx prisma migrate diff \
  --from-config-datasource prisma.config.ts \
  --to-schema prisma/schema.prisma \
  --script > prisma/migrations/20260806120000_add_receipt_draft/migration.sql
```

Note the flag names: Prisma 7 rejects `--from-schema-datasource` / `--to-schema-datamodel`.

- [ ] **Step 4: Verify the generated SQL contains only the new table**

Run: `cat prisma/migrations/20260806120000_add_receipt_draft/migration.sql`

Expected: a `CREATE TABLE "ReceiptDraft"`, two `CREATE INDEX`, and one `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY`. **If it contains any `DROP` or any `ALTER` to another table, stop** — the local dev database has drifted from `main` and the diff has picked that up. Do not commit that file.

- [ ] **Step 5: Apply to the local dev database and regenerate the client**

```bash
npx prisma migrate deploy
npx prisma generate
```

- [ ] **Step 6: Verify the client has the new accessor**

Run: `npx tsx -e "import p from './src/lib/prisma'; p.receiptDraft.count().then(n => console.log('rows:', n))"`
Expected: `rows: 0`

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: add ReceiptDraft model and migration"
```

---

## Task 2: The draft-lenient payload schema

**Files:**
- Create: `src/modules/receipts/drafts.schema.ts`
- Test: `src/modules/receipts/drafts.schema.test.ts`

**Interfaces:**
- Consumes: `MAX_RECEIPT_ROWS`, `MAX_ITEMS_PER_ROW` from `@/modules/transfers/receipt-lines`.
- Produces: `receiptDraftSchema` (Zod), `type ReceiptDraftPayload`, `EMPTY_DRAFT_PARTY`, `formatDraftLabel(recipientName: string | null, itemCount: number): string`, `draftLabel(payload): string`.

This file is **pure** — no `server-only`, no Prisma — so both the Server Action and client components can import the type.

- [ ] **Step 1: Write the failing test**

Create `src/modules/receipts/drafts.schema.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { receiptDraftSchema, draftLabel } from "./drafts.schema";

describe("receiptDraftSchema", () => {
  it("accepts a completely empty form (that is what a draft IS)", () => {
    const r = receiptDraftSchema.safeParse({});
    expect(r.success).toBe(true);
    expect(r.data!.itemIds).toEqual([]);
    expect(r.data!.sender.name).toBe("");
    expect(r.data!.receiver.isDcsim).toBe(false);
  });

  it("keeps blank strings rather than collapsing them to undefined", () => {
    const r = receiptDraftSchema.parse({ receiver: { name: "  " } });
    expect(r.receiver.name).toBe("");
  });

  it("strips unknown keys so a crafted POST cannot smuggle fields in", () => {
    const r = receiptDraftSchema.parse({ receiverSignature: "data:image/png;base64,AAA", evil: 1 });
    expect(r).not.toHaveProperty("receiverSignature");
    expect(r).not.toHaveProperty("evil");
  });

  it("rejects an over-long string", () => {
    expect(receiptDraftSchema.safeParse({ receiver: { name: "x".repeat(201) } }).success).toBe(false);
  });

  it("rejects more itemIds than a receipt could ever hold", () => {
    const ids = Array.from({ length: 181 }, (_, i) => `i${i}`);
    expect(receiptDraftSchema.safeParse({ itemIds: ids }).success).toBe(false);
  });

  it("rejects more lines than MAX_RECEIPT_ROWS", () => {
    const lines = Array.from({ length: 19 }, () => ({ make: "Dell", model: "5420" }));
    expect(receiptDraftSchema.safeParse({ lines }).success).toBe(false);
  });

  it("keeps quantities as typed strings, not numbers", () => {
    const r = receiptDraftSchema.parse({ lines: [{ make: "Dell", model: "5420", qtyAuth: "2", qtyIssued: "" }] });
    expect(r.lines[0].qtyAuth).toBe("2");
    expect(r.lines[0].qtyIssued).toBe("");
  });

  it("rejects an unknown service type", () => {
    const service = [{ itemId: "i1", serviceType: "LASER" }];
    expect(receiptDraftSchema.safeParse({ service }).success).toBe(false);
  });
});

describe("draftLabel", () => {
  it("uses the recipient name and item count", () => {
    const p = receiptDraftSchema.parse({ receiver: { name: "Doe, Jane" }, itemIds: ["a", "b"] });
    expect(draftLabel(p)).toBe("Doe, Jane · 2 items");
  });

  it("singularises one item", () => {
    const p = receiptDraftSchema.parse({ receiver: { name: "Doe, Jane" }, itemIds: ["a"] });
    expect(draftLabel(p)).toBe("Doe, Jane · 1 item");
  });

  it("falls back when no recipient has been typed yet", () => {
    const p = receiptDraftSchema.parse({ itemIds: ["a"] });
    expect(draftLabel(p)).toBe("No recipient yet · 1 item");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/modules/receipts/drafts.schema.test.ts`
Expected: FAIL — `Failed to resolve import "./drafts.schema"`

- [ ] **Step 3: Write the schema**

Create `src/modules/receipts/drafts.schema.ts`:

```ts
import { z } from "zod";
import { MAX_RECEIPT_ROWS, MAX_ITEMS_PER_ROW } from "@/modules/transfers/receipt-lines";

// A saved draft is an INCOMPLETE receipt, so this schema is deliberately NOT
// `receiptSchema`. That one describes a receipt that is ready to file — every
// required party field present, a signature attached. This one accepts whatever
// the operator had typed when they hit Save, including nothing at all.
//
// What it still does is BOUND everything, because `ReceiptDraft.payload` is a
// user-writable Json column: without caps a crafted POST could store megabytes.
// Every field is capped, both arrays are capped, and z.object() strips unknown
// keys (which is what keeps `receiverSignature` out even though the form posts
// it — see the no-signature rule in the design spec).

const NAME_MAX = 200;
const SHORT_MAX = 120;
const NOTE_MAX = 500;
const ID_MAX = 64;
const NUMERIC_MAX = 10; // "3650" and friends; these stay strings, see below

/** Trimmed, capped, and defaulting to "" — a draft keeps blanks as blanks. */
const text = (max: number) => z.string().trim().max(max).default("");

// NOT `as const`: this is passed to Zod's `.default()`, which wants a mutable
// object matching the schema's input type — a readonly literal fights it.
export const EMPTY_DRAFT_PARTY = {
  isDcsim: false, name: "", rank: "", unit: "", contact: "", email: "",
};

const draftPartySchema = z.object({
  isDcsim: z.boolean().default(false),
  name: text(NAME_MAX),
  rank: text(SHORT_MAX),
  unit: text(SHORT_MAX),
  contact: text(SHORT_MAX),
  email: text(SHORT_MAX),
});

// Quantities stay STRINGS. The builder's inputs are controlled strings, and a
// draft should restore exactly what was typed — coercing to a number here would
// turn a half-typed "" into 0 and restore a quantity the operator never entered.
// Coercion happens at FILE time, in receiptSchema, where it belongs.
const draftLineSchema = z.object({
  make: text(SHORT_MAX),
  model: text(SHORT_MAX),
  qtyAuth: text(NUMERIC_MAX),
  qtyIssued: text(NUMERIC_MAX),
});

const draftServiceSchema = z.object({
  itemId: z.string().trim().min(1).max(ID_MAX),
  serviceType: z.enum(["REIMAGE", "REPAIR", "OTHER"]),
  note: text(NOTE_MAX),
  days: text(NUMERIC_MAX),
});

export const receiptDraftSchema = z.object({
  itemIds: z.array(z.string().trim().min(1).max(ID_MAX)).max(MAX_RECEIPT_ROWS * MAX_ITEMS_PER_ROW).default([]),
  lines: z.array(draftLineSchema).max(MAX_RECEIPT_ROWS).default([]),
  sender: draftPartySchema.default(EMPTY_DRAFT_PARTY),
  receiver: draftPartySchema.default(EMPTY_DRAFT_PARTY),
  returnDays: text(NUMERIC_MAX),
  service: z.array(draftServiceSchema).max(MAX_RECEIPT_ROWS * MAX_ITEMS_PER_ROW).default([]),
});

export type ReceiptDraftPayload = z.infer<typeof receiptDraftSchema>;

/** The auto-label shown in the account list. Derived, never user-supplied —
 *  there is no name field to fill on a phone mid-scan.
 *
 *  Takes the two values rather than a payload, because `listDrafts` renders the
 *  list from the DENORMALIZED columns and must not deserialize a payload just to
 *  build a label. One definition of the wording, two callers. */
export function formatDraftLabel(recipientName: string | null, itemCount: number): string {
  return `${recipientName || "No recipient yet"} · ${itemCount} item${itemCount === 1 ? "" : "s"}`;
}

export function draftLabel(p: ReceiptDraftPayload): string {
  return formatDraftLabel(p.receiver.name || null, p.itemIds.length);
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/modules/receipts/drafts.schema.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add src/modules/receipts/drafts.schema.ts src/modules/receipts/drafts.schema.test.ts
git commit -m "feat: add draft-lenient receipt payload schema"
```

---

## Task 3: The draft service

**Files:**
- Create: `src/modules/receipts/drafts.service.ts`
- Create: `src/modules/receipts/drafts.errors.ts`
- Test: `src/modules/receipts/drafts.service.test.ts`

**Interfaces:**
- Consumes: `receiptDraftSchema`, `ReceiptDraftPayload`, `draftLabel` (Task 2).
- Produces:
  - `MAX_DRAFTS_PER_USER = 25`
  - `saveDraft(userId: string, payload: ReceiptDraftPayload, draftId?: string): Promise<{ id: string; updatedAt: Date }>`
  - `listDrafts(userId: string): Promise<{ id: string; label: string; updatedAt: Date }[]>`
  - `getDraft(id: string, userId: string): Promise<{ id: string; payload: ReceiptDraftPayload; updatedAt: Date } | null>` — throws `DraftError("CORRUPT")` when the stored payload no longer parses
  - `deleteDraft(id: string, userId: string): Promise<void>`
  - `class DraftError extends Error` with `code: "TOO_MANY" | "CORRUPT"`

- [ ] **Step 1: Write the failing test**

Create `src/modules/receipts/drafts.service.test.ts`:

```ts
import { beforeAll, beforeEach, expect, test } from "vitest";
import prisma from "@/lib/prisma";
import { resetDb, migrateTestDb } from "../../../tests/helpers/db";
import { saveDraft, listDrafts, getDraft, deleteDraft, MAX_DRAFTS_PER_USER } from "./drafts.service";
import { receiptDraftSchema } from "./drafts.schema";

let aliceId: string;
let bobId: string;

beforeAll(() => migrateTestDb());
beforeEach(async () => {
  await resetDb();
  const [a, b] = await Promise.all([
    prisma.user.create({ data: { name: "Alice", email: "alice@x.co", passwordHash: "x" } }),
    prisma.user.create({ data: { name: "Bob", email: "bob@x.co", passwordHash: "x" } }),
  ]);
  aliceId = a.id;
  bobId = b.id;
});

const payload = (over: Record<string, unknown> = {}) => receiptDraftSchema.parse(over);

test("saveDraft round-trips the payload unchanged", async () => {
  const p = payload({ itemIds: ["i1", "i2"], receiver: { name: "Doe, Jane", unit: "A Co" }, returnDays: "7" });
  const { id } = await saveDraft(aliceId, p);
  const got = await getDraft(id, aliceId);
  expect(got!.payload).toEqual(p);
});

test("saveDraft denormalises the recipient name and item count for the list", async () => {
  const { id } = await saveDraft(aliceId, payload({ itemIds: ["i1", "i2"], receiver: { name: "Doe, Jane" } }));
  const row = await prisma.receiptDraft.findUniqueOrThrow({ where: { id } });
  expect(row.recipientName).toBe("Doe, Jane");
  expect(row.itemCount).toBe(2);
});

test("saveDraft with a draftId UPDATES in place instead of creating a second row", async () => {
  const { id } = await saveDraft(aliceId, payload({ receiver: { name: "First" } }));
  const again = await saveDraft(aliceId, payload({ receiver: { name: "Second" } }), id);
  expect(again.id).toBe(id);
  expect(await prisma.receiptDraft.count({ where: { userId: aliceId } })).toBe(1);
  expect((await getDraft(id, aliceId))!.payload.receiver.name).toBe("Second");
});

test("saveDraft cannot overwrite another user's draft by passing its id", async () => {
  const { id } = await saveDraft(aliceId, payload({ receiver: { name: "Alice's" } }));
  await saveDraft(bobId, payload({ receiver: { name: "Bob's" } }), id);
  // Alice's row is untouched...
  expect((await getDraft(id, aliceId))!.payload.receiver.name).toBe("Alice's");
  // ...and Bob got his own new row rather than silently editing hers.
  const bobs = await listDrafts(bobId);
  expect(bobs).toHaveLength(1);
  expect(bobs[0].id).not.toBe(id);
});

test("getDraft returns null for another user's draft", async () => {
  const { id } = await saveDraft(aliceId, payload());
  expect(await getDraft(id, bobId)).toBeNull();
});

test("deleteDraft does not delete another user's draft", async () => {
  const { id } = await saveDraft(aliceId, payload());
  await deleteDraft(id, bobId);
  expect(await getDraft(id, aliceId)).not.toBeNull();
});

test("listDrafts returns only my drafts, newest first, with a derived label", async () => {
  await saveDraft(bobId, payload({ receiver: { name: "Bob's" } }));
  const older = await saveDraft(aliceId, payload({ receiver: { name: "Older" }, itemIds: ["i1"] }));
  await prisma.receiptDraft.update({ where: { id: older.id }, data: { updatedAt: new Date("2020-01-01") } });
  await saveDraft(aliceId, payload({ receiver: { name: "Newer" }, itemIds: ["i1", "i2"] }));

  const list = await listDrafts(aliceId);
  expect(list).toHaveLength(2);
  expect(list[0].label).toBe("Newer · 2 items");
  expect(list[1].label).toBe("Older · 1 item");
});

test("saveDraft refuses past the per-user cap rather than pruning the oldest", async () => {
  for (let i = 0; i < MAX_DRAFTS_PER_USER; i++) await saveDraft(aliceId, payload({ itemIds: [`i${i}`] }));
  await expect(saveDraft(aliceId, payload())).rejects.toMatchObject({ code: "TOO_MANY" });
  // The cap does not block UPDATING an existing draft.
  const mine = await listDrafts(aliceId);
  await expect(saveDraft(aliceId, payload({ receiver: { name: "edited" } }), mine[0].id)).resolves.toBeTruthy();
});

test("getDraft reports a corrupt payload instead of throwing", async () => {
  const { id } = await saveDraft(aliceId, payload());
  await prisma.receiptDraft.update({ where: { id }, data: { payload: { itemIds: "not-an-array" } } });
  await expect(getDraft(id, aliceId)).rejects.toMatchObject({ code: "CORRUPT" });
});

test("deleting the user cascades their drafts away", async () => {
  await saveDraft(aliceId, payload());
  await prisma.user.delete({ where: { id: aliceId } });
  expect(await prisma.receiptDraft.count()).toBe(0);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/modules/receipts/drafts.service.test.ts`
Expected: FAIL — cannot resolve `./drafts.service`

- [ ] **Step 3: Write the error type**

Create `src/modules/receipts/drafts.errors.ts`:

```ts
export type DraftErrorCode = "TOO_MANY" | "CORRUPT";

export class DraftError extends Error {
  constructor(public readonly code: DraftErrorCode) {
    super(code);
    this.name = "DraftError";
  }
}
```

- [ ] **Step 4: Write the service**

Create `src/modules/receipts/drafts.service.ts`:

```ts
import "server-only";
import prisma from "@/lib/prisma";
import { receiptDraftSchema, formatDraftLabel, type ReceiptDraftPayload } from "./drafts.schema";
import { DraftError } from "./drafts.errors";

// Every read and write here is scoped by `userId`, and the scope is part of the
// WHERE clause (findFirst / updateMany / deleteMany) rather than a check after
// the fact — a mismatched owner therefore touches zero rows instead of throwing
// a Prisma error that a caller might swallow. Same shape as
// signatures.service.ts. Callers pass the id from the authenticated session;
// a userId is NEVER accepted from client input.

export const MAX_DRAFTS_PER_USER = 25;

export async function saveDraft(
  userId: string,
  payload: ReceiptDraftPayload,
  draftId?: string,
): Promise<{ id: string; updatedAt: Date }> {
  // Re-parse at the service boundary: this module is reachable from more than
  // one action, and the caps in the schema are the only thing bounding what
  // lands in an untyped Json column.
  const data = receiptDraftSchema.parse(payload);
  const denormalized = {
    payload: data,
    recipientName: data.receiver.name || null,
    itemCount: data.itemIds.length,
  };

  if (draftId) {
    // updateMany, so `userId` is part of the WHERE. count === 0 means the id
    // was bogus or belongs to someone else; fall through and create a new draft
    // rather than erroring — the operator's work must not be lost because a
    // stale tab held a since-deleted id.
    const { count } = await prisma.receiptDraft.updateMany({
      where: { id: draftId, userId },
      data: denormalized,
    });
    if (count === 1) {
      const row = await prisma.receiptDraft.findUniqueOrThrow({
        where: { id: draftId },
        select: { id: true, updatedAt: true },
      });
      return row;
    }
  }

  // The cap applies to CREATING a draft only; an update above has already
  // returned. Refusing (rather than pruning the oldest) is deliberate: silently
  // deleting the technician's own saved work is worse than a message they can
  // act on.
  const existing = await prisma.receiptDraft.count({ where: { userId } });
  if (existing >= MAX_DRAFTS_PER_USER) throw new DraftError("TOO_MANY");

  return prisma.receiptDraft.create({
    data: { ...denormalized, userId },
    select: { id: true, updatedAt: true },
  });
}

/** Newest first. Reads only the denormalized columns — a payload is never
 *  deserialized to render the list. */
export async function listDrafts(userId: string): Promise<{ id: string; label: string; updatedAt: Date }[]> {
  const rows = await prisma.receiptDraft.findMany({
    where: { userId },
    select: { id: true, recipientName: true, itemCount: true, updatedAt: true },
    orderBy: { updatedAt: "desc" },
  });
  // Built from the denormalized columns via the SHARED formatter, so the
  // account list and the builder can never word a label differently.
  return rows.map((r) => ({
    id: r.id,
    label: formatDraftLabel(r.recipientName, r.itemCount),
    updatedAt: r.updatedAt,
  }));
}

export async function getDraft(
  id: string,
  userId: string,
): Promise<{ id: string; payload: ReceiptDraftPayload; updatedAt: Date } | null> {
  const row = await prisma.receiptDraft.findFirst({
    where: { id, userId },
    select: { id: true, payload: true, updatedAt: true },
  });
  if (!row) return null;
  // A Json column is untyped at the DB level, so a payload written by an older
  // deploy (or by hand) must not be able to crash the builder. Report it as a
  // corrupt draft the operator can delete.
  const parsed = receiptDraftSchema.safeParse(row.payload);
  if (!parsed.success) throw new DraftError("CORRUPT");
  return { id: row.id, payload: parsed.data, updatedAt: row.updatedAt };
}

export async function deleteDraft(id: string, userId: string): Promise<void> {
  // deleteMany, so a foreign or bogus id is a no-op rather than a throw.
  await prisma.receiptDraft.deleteMany({ where: { id, userId } });
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/modules/receipts/drafts.service.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 6: Commit**

```bash
git add src/modules/receipts/drafts.service.ts src/modules/receipts/drafts.errors.ts src/modules/receipts/drafts.service.test.ts
git commit -m "feat: add owner-scoped receipt draft service"
```

---

## Task 4: The 30-day purge sweep

**Files:**
- Modify: `src/modules/receipts/drafts.service.ts` (append `purgeStaleDrafts`)
- Modify: `src/app/api/cron/purge/route.ts:4,26-36`
- Test: `src/modules/receipts/drafts.purge.test.ts`

**Interfaces:**
- Consumes: `prisma.receiptDraft` (Task 1).
- Produces: `purgeStaleDrafts(now: Date): Promise<{ deletedCount: number }>`, `DRAFT_RETENTION_DAYS = 30`.

- [ ] **Step 1: Write the failing test**

Create `src/modules/receipts/drafts.purge.test.ts`:

```ts
import { beforeAll, beforeEach, expect, test } from "vitest";
import prisma from "@/lib/prisma";
import { resetDb, migrateTestDb } from "../../../tests/helpers/db";
import { saveDraft, purgeStaleDrafts, DRAFT_RETENTION_DAYS } from "./drafts.service";
import { receiptDraftSchema } from "./drafts.schema";

let userId: string;
const NOW = new Date("2026-08-06T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

beforeAll(() => migrateTestDb());
beforeEach(async () => {
  await resetDb();
  const u = await prisma.user.create({ data: { name: "A", email: "a@x.co", passwordHash: "x" } });
  userId = u.id;
});

async function draftUpdatedAt(when: Date) {
  const { id } = await saveDraft(userId, receiptDraftSchema.parse({}));
  await prisma.receiptDraft.update({ where: { id }, data: { updatedAt: when } });
  return id;
}

test("deletes drafts untouched for longer than the retention window", async () => {
  const stale = await draftUpdatedAt(daysAgo(DRAFT_RETENTION_DAYS + 1));
  const { deletedCount } = await purgeStaleDrafts(NOW);
  expect(deletedCount).toBe(1);
  expect(await prisma.receiptDraft.findUnique({ where: { id: stale } })).toBeNull();
});

test("spares a draft inside the window", async () => {
  const fresh = await draftUpdatedAt(daysAgo(DRAFT_RETENTION_DAYS - 1));
  const { deletedCount } = await purgeStaleDrafts(NOW);
  expect(deletedCount).toBe(0);
  expect(await prisma.receiptDraft.findUnique({ where: { id: fresh } })).not.toBeNull();
});

test("measures from updatedAt, so re-saving an old draft keeps it alive", async () => {
  const id = await draftUpdatedAt(daysAgo(DRAFT_RETENTION_DAYS + 5));
  await saveDraft(userId, receiptDraftSchema.parse({ receiver: { name: "touched" } }), id);
  const { deletedCount } = await purgeStaleDrafts(NOW);
  expect(deletedCount).toBe(0);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/modules/receipts/drafts.purge.test.ts`
Expected: FAIL — `purgeStaleDrafts` is not exported

- [ ] **Step 3: Append the sweep to `drafts.service.ts`**

```ts
// Drafts are scratch work, and a device list goes stale much faster than a
// filed record — hence 30 days here against the closed-receipt purge's 90.
// Measured on `updatedAt`, so re-saving a draft resets its clock.
export const DRAFT_RETENTION_DAYS = 30;

export async function purgeStaleDrafts(now: Date): Promise<{ deletedCount: number }> {
  const cutoff = new Date(now.getTime() - DRAFT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const { count } = await prisma.receiptDraft.deleteMany({ where: { updatedAt: { lt: cutoff } } });
  return { deletedCount: count };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/modules/receipts/drafts.purge.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Wire it into the nightly worker**

In `src/app/api/cron/purge/route.ts`, add the import after line 5:

```ts
import { purgeStaleDrafts } from "@/modules/receipts/drafts.service";
```

Replace the `Promise.all` block (lines 26-31) and the response (lines 32-37):

```ts
    const [transfers, users, drafts, transferAlerts, serviceAlerts] = await Promise.all([
      purgeExpiredTransfers(now),
      purgeDeactivatedUsers(now),
      purgeStaleDrafts(now),
      sendOverdueTransferAlerts(now),
      sendOverdueServiceAlerts(now),
    ]);
    return NextResponse.json({
      ok: true,
      transfers: { deletedCount: transfers.deletedCount },
      users: { deletedCount: users.deletedCount, skippedCount: users.skipped.length },
      drafts: { deletedCount: drafts.deletedCount },
      alerts: { overdueTransfers: transferAlerts.alertedCount, overdueService: serviceAlerts.alertedCount },
    });
```

Also update the file's header comment (lines 13-15) to mention the third sweep.

- [ ] **Step 6: Verify the route still type-checks**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add src/modules/receipts/drafts.service.ts src/modules/receipts/drafts.purge.test.ts src/app/api/cron/purge/route.ts
git commit -m "feat: purge receipt drafts after 30 idle days"
```

---

## Task 5: The Server Actions

**Files:**
- Create: `src/modules/receipts/drafts.form.ts`
- Create: `src/app/actions/drafts.ts`
- Test: `src/app/actions/drafts.test.ts`

**Interfaces:**
- Consumes: `saveDraft`, `deleteDraft`, `MAX_DRAFTS_PER_USER`, `DraftError` (Tasks 3-4); `parseReceiptForm` from `@/app/actions/receipts.parse`; `parseServiceMap` from `@/modules/service-queue/service-form`.
- Produces:
  - `draftPayloadFromForm(formData: FormData): unknown` — in `drafts.form.ts`
  - `saveDraftAction(prev: unknown, formData: FormData): Promise<{ draftId: string; savedAt: number } | { error: string }>`
  - `deleteDraftAction(formData: FormData): Promise<void>`

> **Why two files.** `draftPayloadFromForm` is synchronous, and a file-level
> `"use server"` directive marks **every export** in the file as a Server
> Function — which must be async
> (`node_modules/next/dist/docs/01-app/01-getting-started/07-mutating-data.md:17,37`).
> Exporting it from `actions/drafts.ts` is a build error. It also has no
> business being a network-callable endpoint: it is pure form parsing. So it
> lives in its own pure module, which is additionally what lets the test import
> it directly.

- [ ] **Step 1: Write the failing test**

Create `src/app/actions/drafts.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const requireUser = vi.fn();
const saveDraft = vi.fn();
const deleteDraft = vi.fn();

vi.mock("@/lib/authz", () => ({
  requireUser: () => requireUser(),
  AuthError: class AuthError extends Error {},
}));
vi.mock("@/modules/receipts/drafts.service", () => ({
  saveDraft: (...a: unknown[]) => saveDraft(...a),
  deleteDraft: (...a: unknown[]) => deleteDraft(...a),
  MAX_DRAFTS_PER_USER: 25,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { saveDraftAction, deleteDraftAction } from "./drafts";
import { draftPayloadFromForm } from "@/modules/receipts/drafts.form";
import { DraftError } from "@/modules/receipts/drafts.errors";

beforeEach(() => {
  vi.clearAllMocks();
  requireUser.mockResolvedValue({ id: "u1", role: "USER" });
  saveDraft.mockResolvedValue({ id: "d1", updatedAt: new Date("2026-08-06T10:00:00Z") });
});

function form(entries: [string, string][]): FormData {
  const fd = new FormData();
  for (const [k, v] of entries) fd.append(k, v);
  return fd;
}

describe("draftPayloadFromForm", () => {
  it("NEVER includes the recipient signature, even when the form posts one", () => {
    const fd = form([
      ["receiverSignature", "data:image/png;base64,AAAA"],
      ["receiverName", "Doe, Jane"],
    ]);
    expect(JSON.stringify(draftPayloadFromForm(fd))).not.toContain("data:image/png");
  });

  it("captures item ids, both parties, quantities, return days and service rows", () => {
    const fd = form([
      ["itemId", "i1"],
      ["itemId", "i2"],
      ["senderIsDcsim", "on"],
      ["senderName", "SGT Smith"],
      ["receiverName", "Doe, Jane"],
      ["receiverUnit", "A Co"],
      ["line[0][make]", "Dell"],
      ["line[0][model]", "5420"],
      ["line[0][qtyAuth]", "2"],
      ["line[0][qtyIssued]", "2"],
      ["returnDays", "7"],
      ["service[i1][needs]", "on"],
      ["service[i1][type]", "OTHER"],
      ["service[i1][note]", "cracked screen"],
      ["service[i1][days]", "5"],
    ]);
    const p = draftPayloadFromForm(fd) as ReturnType<typeof draftPayloadFromForm> & Record<string, never>;
    expect(p).toMatchObject({
      itemIds: ["i1", "i2"],
      sender: { isDcsim: true, name: "SGT Smith" },
      receiver: { isDcsim: false, name: "Doe, Jane", unit: "A Co" },
      lines: [{ make: "Dell", model: "5420", qtyAuth: "2", qtyIssued: "2" }],
      returnDays: "7",
      service: [{ itemId: "i1", serviceType: "OTHER", note: "cracked screen", days: "5" }],
    });
  });
});

describe("saveDraftAction", () => {
  it("saves under the acting user's id and returns the new draft id", async () => {
    const r = await saveDraftAction(undefined, form([["receiverName", "Doe, Jane"]]));
    expect(saveDraft).toHaveBeenCalledWith("u1", expect.objectContaining({ receiver: expect.objectContaining({ name: "Doe, Jane" }) }), undefined);
    expect(r).toMatchObject({ draftId: "d1" });
  });

  it("passes an existing draftId through so a re-save updates in place", async () => {
    await saveDraftAction(undefined, form([["draftId", "d9"], ["receiverName", "X"]]));
    expect(saveDraft).toHaveBeenCalledWith("u1", expect.anything(), "d9");
  });

  it("reports the per-user cap in plain language", async () => {
    saveDraft.mockRejectedValueOnce(new DraftError("TOO_MANY"));
    expect(await saveDraftAction(undefined, form([]))).toEqual({
      error: "You have 25 saved drafts — delete one before saving another.",
    });
  });

  it("returns a generic message and logs on an unexpected failure", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    saveDraft.mockRejectedValueOnce(new Error("boom"));
    expect(await saveDraftAction(undefined, form([]))).toEqual({
      error: "Something went wrong saving the draft. Please try again.",
    });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("never saves when the session is rejected", async () => {
    requireUser.mockRejectedValueOnce(new Error("FORBIDDEN"));
    await expect(saveDraftAction(undefined, form([]))).rejects.toThrow();
    expect(saveDraft).not.toHaveBeenCalled();
  });
});

describe("deleteDraftAction", () => {
  it("deletes scoped to the acting user", async () => {
    await deleteDraftAction(form([["id", "d1"]]));
    expect(deleteDraft).toHaveBeenCalledWith("d1", "u1");
  });

  it("is a no-op with no id", async () => {
    await deleteDraftAction(form([]));
    expect(deleteDraft).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/app/actions/drafts.test.ts`
Expected: FAIL — cannot resolve `./drafts`

- [ ] **Step 3: Write the pure form parser**

Create `src/modules/receipts/drafts.form.ts`:

```ts
import { parseReceiptForm } from "@/app/actions/receipts.parse";
import { parseServiceMap } from "@/modules/service-queue/service-form";

// Build the draft payload from the SAME FormData the Create button posts.
// "Save draft" is a second submit button on the builder form (formAction +
// formNoValidate), so there is exactly one definition of what is on a receipt —
// the form itself — and a draft cannot drift from what would be filed.
//
// `receiverSignature` is deliberately dropped here AND absent from
// receiptDraftSchema, which strips unknown keys. Two independent barriers,
// because a signature attests to a specific item list and must never be
// restored onto a list that has since changed.
//
// NOT in actions/drafts.ts: a file-level "use server" makes every export a
// network-callable Server Function, which must be async. This is synchronous
// pure parsing and has no business being an endpoint.
export function draftPayloadFromForm(formData: FormData) {
  const raw = parseReceiptForm(formData);
  // parseServiceMap keeps only rows whose "Needs service?" was actually
  // checked, and normalises the day count. An invalid days value ("abc",
  // "5000") therefore does not survive into the draft — it would not survive
  // filing either, so the draft matches what the receipt would do.
  const service = [...parseServiceMap(formData)].map(([itemId, sel]) => ({
    itemId,
    serviceType: sel.serviceType,
    note: sel.note ?? "",
    days: sel.overrideDays == null ? "" : String(sel.overrideDays),
  }));
  return {
    itemIds: raw.itemIds,
    lines: raw.lines,
    sender: raw.sender,
    receiver: raw.receiver,
    returnDays: raw.returnDays,
    service,
  };
}
```

- [ ] **Step 4: Write the actions**

Create `src/app/actions/drafts.ts`:

```ts
"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/authz";
import { saveDraft, deleteDraft, MAX_DRAFTS_PER_USER } from "@/modules/receipts/drafts.service";
import { DraftError } from "@/modules/receipts/drafts.errors";
import { receiptDraftSchema } from "@/modules/receipts/drafts.schema";
import { draftPayloadFromForm } from "@/modules/receipts/drafts.form";

export async function saveDraftAction(_prev: unknown, formData: FormData) {
  const user = await requireUser();

  const parsed = receiptDraftSchema.safeParse(draftPayloadFromForm(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "That draft could not be saved." };
  }

  // Blank on a fresh builder; present once this form has been saved at least
  // once, so a second save updates rather than creating a duplicate.
  const draftId = String(formData.get("draftId") ?? "").trim() || undefined;

  try {
    const saved = await saveDraft(user.id, parsed.data, draftId);
    revalidatePath("/account");
    return { draftId: saved.id, savedAt: saved.updatedAt.getTime() };
  } catch (e) {
    if (e instanceof DraftError && e.code === "TOO_MANY") {
      return { error: `You have ${MAX_DRAFTS_PER_USER} saved drafts — delete one before saving another.` };
    }
    console.error("[saveDraftAction] unexpected error:", e);
    return { error: "Something went wrong saving the draft. Please try again." };
  }
}

export async function deleteDraftAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return;
  await deleteDraft(id, user.id);
  revalidatePath("/account");
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/app/actions/drafts.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 6: Verify the "use server" module only exports async functions**

Run: `npm run build`
Expected: success. A synchronous export from `src/app/actions/drafts.ts` fails
here with "Server Actions must be async functions" — if that appears, the
parser did not get moved to `drafts.form.ts`.

- [ ] **Step 7: Commit**

```bash
git add src/modules/receipts/drafts.form.ts src/app/actions/drafts.ts src/app/actions/drafts.test.ts
git commit -m "feat: add save/delete draft server actions"
```

---

## Task 6: The "Save draft" button on the builder

**Files:**
- Modify: `src/app/receipts/new/ReceiptBuilderForm.tsx`
- Modify: `src/app/receipts/new/page.tsx:49` (remove the `<h1>` from the non-error branch)
- Test: `src/app/receipts/new/ReceiptBuilderForm.drafts.test.tsx`

**Interfaces:**
- Consumes: `saveDraftAction` (Task 5).
- Produces: `ReceiptBuilderForm` gains optional props `draftId?: string` and `draftValues?: ReceiptDraftPayload` (the latter used in Task 7).

- [ ] **Step 1: Write the failing test**

Create `src/app/receipts/new/ReceiptBuilderForm.drafts.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/app/actions/receipts", () => ({ createReceiptAction: vi.fn() }));
vi.mock("@/app/actions/drafts", () => ({ saveDraftAction: vi.fn() }));
vi.mock("@/app/actions/scan", () => ({ lookupScannedItem: vi.fn() }));

import { ReceiptBuilderForm } from "./ReceiptBuilderForm";

const ITEMS = [{ itemId: "i1", make: "Dell", model: "5420", serialNumber: "SN1", holderName: null }];

describe("Save draft button", () => {
  it("renders in the page header, to the right of the title", () => {
    render(<ReceiptBuilderForm initialItems={ITEMS} signatures={[]} />);
    const btn = screen.getByRole("button", { name: /save draft/i });
    expect(btn).toBeTruthy();
    expect(screen.getByRole("heading", { name: /new hand receipt/i })).toBeTruthy();
    // `.spacer` is what pushes it opposite the title in the shared `.row` idiom.
    expect(btn.className).toContain("spacer");
  });

  it("carries formNoValidate so a half-filled form can still be saved", () => {
    render(<ReceiptBuilderForm initialItems={ITEMS} signatures={[]} />);
    const btn = screen.getByRole("button", { name: /save draft/i }) as HTMLButtonElement;
    expect(btn.formNoValidate).toBe(true);
    expect(btn.type).toBe("submit");
  });

  it("posts a draftId when resuming, so a re-save updates rather than duplicates", () => {
    const { container } = render(<ReceiptBuilderForm initialItems={ITEMS} signatures={[]} draftId="d9" />);
    const hidden = container.querySelector('input[name="draftId"]') as HTMLInputElement;
    expect(hidden.value).toBe("d9");
  });

  it("posts an empty draftId on a fresh builder", () => {
    const { container } = render(<ReceiptBuilderForm initialItems={ITEMS} signatures={[]} />);
    const hidden = container.querySelector('input[name="draftId"]') as HTMLInputElement;
    expect(hidden.value).toBe("");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/app/receipts/new/ReceiptBuilderForm.drafts.test.tsx`
Expected: FAIL — no button named "Save draft"

- [ ] **Step 3: Add the imports and draft state to `ReceiptBuilderForm`**

At the top of the file, after the existing imports:

```tsx
import { saveDraftAction } from "@/app/actions/drafts";
import type { ReceiptDraftPayload } from "@/modules/receipts/drafts.schema";
```

Change the component signature (line 250) to accept the two new props:

```tsx
export function ReceiptBuilderForm({ initialItems, senderPrefill, signatures, draftId: initialDraftId, draftValues }: {
  initialItems: BuilderItem[];
  senderPrefill?: Prefill;
  signatures: PickableSignature[];
  draftId?: string;
  draftValues?: ReceiptDraftPayload;
}) {
```

Immediately after the existing `useActionState` for `createReceiptAction` (line 255), add a SECOND, separate one:

```tsx
  // A separate useActionState from the Create one above: a failed draft save
  // must never render as a failed receipt, and vice versa.
  const [draftState, saveDraft, savingDraft] = useActionState(saveDraftAction, undefined);

  // Blank until this form has been saved once. Held in state (not just seeded
  // from the prop) so the id returned by the FIRST save is posted by the
  // second — otherwise every save creates another draft.
  const [draftId, setDraftId] = useState(initialDraftId ?? "");

  // Guarded render-time write, compared on the action state's IDENTITY — the
  // "storing information from previous renders" pattern used by
  // SignatureManager.tsx:28-35 and ItemDetailsCard.tsx:43-47. NOT a useEffect:
  // the repo lints react-hooks/set-state-in-effect as an error.
  const [prevDraftState, setPrevDraftState] = useState(draftState);
  if (draftState !== prevDraftState) {
    setPrevDraftState(draftState);
    if (draftState && "draftId" in draftState && draftState.draftId) setDraftId(draftState.draftId);
  }
```

- [ ] **Step 4: Render the header row and the hidden input**

Replace the opening of the returned form (line 474-475):

```tsx
  return (
    <form action={action} className="stack">
      {items.map((it) => <input key={it.itemId} type="hidden" name="itemId" value={it.itemId} />)}
```

with:

```tsx
  return (
    <form action={action} className="stack">
      {/* The title lives INSIDE the form because the Save-draft button must:
          `formAction` only applies to a submit button within the form it posts.
          `.row` + `.spacer` is the shared title-left/action-right idiom from
          items/page.tsx:67-77, and `.row` wraps, so on a phone the button drops
          below the heading instead of crushing it. */}
      <div className="row">
        <h1 className="page-title">New hand receipt</h1>
        <button
          type="submit"
          formAction={saveDraft}
          /* Without this the browser refuses to submit while a `required`
             field is blank — which is exactly the state a draft captures. */
          formNoValidate
          className="btn btn-secondary spacer"
          style={{ minHeight: "var(--tap)" }}
          disabled={savingDraft}
        >
          {savingDraft ? "Saving…" : "Save draft"}
        </button>
      </div>
      {draftState && "error" in draftState && draftState.error && (
        <p role="alert" className="alert-error">{draftState.error}</p>
      )}
      {draftState && "draftId" in draftState && (
        <p role="status" aria-live="polite" className="alert-success">
          Draft saved. Find it under Account → Draft hand receipts.
        </p>
      )}
      <input type="hidden" name="draftId" value={draftId} />
      {items.map((it) => <input key={it.itemId} type="hidden" name="itemId" value={it.itemId} />)}
```

- [ ] **Step 5: Remove the now-duplicated title from the page**

In `src/app/receipts/new/page.tsx`, delete line 49 (`<h1 className="page-title">New hand receipt</h1>`) and move it into **each** of the two error branches so those still have a heading:

```tsx
        {tooMany ? (
          <>
            <h1 className="page-title">New hand receipt</h1>
            <div className="card empty">This selection has {lines.length} item types — the form holds {MAX_RECEIPT_ROWS}. Split it into two receipts.</div>
          </>
        ) : tooManyPerRow ? (
          <>
            <h1 className="page-title">New hand receipt</h1>
            <div className="card empty">One item type has more than {MAX_ITEMS_PER_ROW} items on a single row. Split that item across two receipts.</div>
          </>
        ) : (
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/app/receipts/new/ReceiptBuilderForm.drafts.test.tsx`
Expected: PASS (4 tests)

- [ ] **Step 7: Run the existing builder tests for regressions**

Run: `npx vitest run src/app/receipts/new/ReceiptBuilderForm.test.tsx`
Expected: PASS — the existing suite must be unaffected

- [ ] **Step 8: Commit**

```bash
git add src/app/receipts/new/ReceiptBuilderForm.tsx src/app/receipts/new/page.tsx src/app/receipts/new/ReceiptBuilderForm.drafts.test.tsx
git commit -m "feat: add Save draft button to the hand receipt builder"
```

---

## Task 7: Resuming a draft

**Files:**
- Modify: `src/app/receipts/new/page.tsx`
- Modify: `src/app/receipts/new/ReceiptBuilderForm.tsx` (seed from `draftValues`; fix `replaceState`)
- Modify: `src/app/receipts/new/ReceiptBuilderForm.drafts.test.tsx` (add cases)
- Test: `src/app/receipts/new/resume-draft.test.ts`

**Interfaces:**
- Consumes: `getDraft` (Task 3), `ReceiptDraftPayload` (Task 2).
- Produces: `splitDraftItems(payloadItemIds, loadedItems)` — a pure helper exported from `src/modules/receipts/drafts.resume.ts` returning `{ keptIds: string[]; droppedIds: string[] }`.

- [ ] **Step 1: Write the failing test for the pure helper**

Create `src/app/receipts/new/resume-draft.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { splitDraftItems } from "@/modules/receipts/drafts.resume";

const loaded = (ids: string[]) => ids.map((id) => ({ id }));

describe("splitDraftItems", () => {
  it("keeps items that are still loadable, in the draft's original order", () => {
    expect(splitDraftItems(["a", "b", "c"], loaded(["c", "a", "b"]))).toEqual({
      keptIds: ["a", "b", "c"],
      droppedIds: [],
    });
  });

  it("drops items that no longer load (deleted or retired)", () => {
    expect(splitDraftItems(["a", "b", "c"], loaded(["a", "c"]))).toEqual({
      keptIds: ["a", "c"],
      droppedIds: ["b"],
    });
  });

  it("reports everything dropped when nothing survives", () => {
    expect(splitDraftItems(["a", "b"], loaded([]))).toEqual({ keptIds: [], droppedIds: ["a", "b"] });
  });

  it("handles an empty draft", () => {
    expect(splitDraftItems([], loaded([]))).toEqual({ keptIds: [], droppedIds: [] });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/app/receipts/new/resume-draft.test.ts`
Expected: FAIL — cannot resolve `@/modules/receipts/drafts.resume`

- [ ] **Step 3: Write the pure helper**

Create `src/modules/receipts/drafts.resume.ts`:

```ts
// Pure, so it can be unit-tested without a database and reused if another
// surface ever resumes a draft. The page does the loading; this decides what
// survived.
//
// Order comes from the DRAFT, not from the load: the operator scanned these in
// a particular order and the restored table should match what they left.
export function splitDraftItems(
  draftItemIds: string[],
  loaded: { id: string }[],
): { keptIds: string[]; droppedIds: string[] } {
  const available = new Set(loaded.map((i) => i.id));
  const keptIds: string[] = [];
  const droppedIds: string[] = [];
  for (const id of draftItemIds) (available.has(id) ? keptIds : droppedIds).push(id);
  return { keptIds, droppedIds };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/app/receipts/new/resume-draft.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Add the `?draft=` branch to the page**

In `src/app/receipts/new/page.tsx`, change the signature and the id resolution
(lines 10-17) to:

```tsx
export default async function NewReceiptPage({ searchParams }: { searchParams: Promise<{ items?: string; draft?: string }> }) {
  const user = await requireUser();
  const { items: itemsParam, draft: draftParam } = await searchParams;

  // Resuming a saved draft. Scoped to the acting user inside getDraft, so
  // another technician's id 404s rather than opening their work.
  let draft: Awaited<ReturnType<typeof getDraft>> = null;
  if (draftParam) {
    try {
      draft = await getDraft(draftParam, user.id);
    } catch (e) {
      if (e instanceof DraftError && e.code === "CORRUPT") {
        return (
          <>
            <SiteHeader />
            <main className="container container-mid stack">
              <h1 className="page-title">New hand receipt</h1>
              <div className="card empty">
                This draft can no longer be read and should be deleted from your account.
              </div>
            </main>
          </>
        );
      }
      throw e;
    }
    if (!draft) notFound();
  }

  const ids = draft
    ? draft.payload.itemIds
    : (itemsParam ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) notFound();

  const loaded = (await Promise.all(ids.map((id) => getItem(id)))).filter((i) => i && i.status === "ACTIVE") as NonNullable<Awaited<ReturnType<typeof getItem>>>[];

  // A draft whose devices have ALL since been retired or deleted must say so.
  // Falling through to notFound() would read as "your draft vanished".
  if (draft && loaded.length === 0) {
    return (
      <>
        <SiteHeader />
        <main className="container container-mid stack">
          <h1 className="page-title">New hand receipt</h1>
          <div className="card empty">
            None of the {ids.length} device{ids.length === 1 ? "" : "s"} on this draft can be issued any
            more — they have been retired or removed from inventory. Delete the draft from your account
            and start again.
          </div>
        </main>
      </>
    );
  }
  if (loaded.length === 0) notFound();

  const { droppedIds } = splitDraftItems(ids, loaded);
```

Add the imports at the top:

```tsx
import { getDraft } from "@/modules/receipts/drafts.service";
import { DraftError } from "@/modules/receipts/drafts.errors";
import { splitDraftItems } from "@/modules/receipts/drafts.resume";
```

- [ ] **Step 6: Pass the draft through to the form**

In the same file, extend the `<ReceiptBuilderForm ... />` props:

```tsx
            senderPrefill={draft ? undefined : senderPrefill}
            signatures={signatures}
            draftId={draft?.id}
            draftValues={draft?.payload}
            droppedItemCount={droppedIds.length}
```

`senderPrefill` is suppressed when resuming: the draft already holds whatever
sender the operator typed, and the "last receiver of these items" guess must not
overwrite it.

- [ ] **Step 7: Seed the form state from `draftValues`**

In `ReceiptBuilderForm.tsx`, add `droppedItemCount?: number` to the props type,
then change the six state initialisers to prefer the draft:

```tsx
  const [returnDays, setReturnDays] = useState(draftValues?.returnDays ?? "");
  const [senderIsDcsim, setSenderIsDcsim] = useState(draftValues?.sender.isDcsim ?? senderPrefill?.isDcsim ?? false);
  const [receiverIsDcsim, setReceiverIsDcsim] = useState(draftValues?.receiver.isDcsim ?? false);
  const [senderName, setSenderName] = useState(draftValues?.sender.name ?? senderPrefill?.name ?? "");
  const [receiverName, setReceiverName] = useState(draftValues?.receiver.name ?? "");
```

And seed the quantity overrides from the draft's lines:

```tsx
  const [qtyEdits, setQtyEdits] = useState<Record<string, { auth?: string; issued?: string }>>(() =>
    Object.fromEntries((draftValues?.lines ?? []).map((l) => [`${l.make} ${l.model}`, { auth: l.qtyAuth, issued: l.qtyIssued }])),
  );
```

Pass the draft's party values into `PartyFields` as its `prefill`:

```tsx
      <PartyFields role="sender" prefill={draftValues ? draftValues.sender : senderPrefill} isDcsim={senderIsDcsim} onIsDcsimChange={setSenderIsDcsim} name={senderName} onNameChange={setSenderName} />
      <PartyFields role="receiver" prefill={draftValues?.receiver} isDcsim={receiverIsDcsim} onIsDcsimChange={onReceiverDcsimChange} hideName={hideReceiverName} name={receiverName} onNameChange={setReceiverName} />
```

`Prefill` and the draft party shape already share the five field names, so no
adapter is needed.

- [ ] **Step 8: Seed `ServiceControls` from the draft**

Change `ServiceControls` (line 176) to accept initial values:

```tsx
function ServiceControls({ itemId, initial }: {
  itemId: string;
  initial?: { serviceType: string; note: string; days: string };
}) {
  const [needs, setNeeds] = useState(!!initial);
  const [type, setType] = useState(initial?.serviceType ?? "REIMAGE");
  const [note, setNote] = useState(initial?.note ?? "");
  const [days, setDays] = useState(initial?.days ?? "");
```

And at its call site (line 528) look the row up by item id:

```tsx
                      {receiverIsDcsim && <td className="is-stacked" data-label="Service"><ServiceControls itemId={itemId} initial={draftService.get(itemId)} /></td>}
```

with, near the other derived values:

```tsx
  // Only rows the operator actually checked are saved (parseServiceMap drops
  // the rest), so a present entry means "Needs service? was on".
  const draftService = useMemo(
    () => new Map((draftValues?.service ?? []).map((s) => [s.itemId, s])),
    [draftValues],
  );
```

- [ ] **Step 9: Render the two restore notices**

Immediately after the header row added in Task 6:

```tsx
      {draftValues && (
        <p role="status" className="alert-success">
          Draft restored — please sign again before filing. A signature is never saved with a draft.
        </p>
      )}
      {!!droppedItemCount && (
        <p role="alert" className="alert-error">
          {droppedItemCount} device{droppedItemCount === 1 ? "" : "s"} from this draft
          {droppedItemCount === 1 ? " is" : " are"} no longer available and{" "}
          {droppedItemCount === 1 ? "has" : "have"} been removed from the list.
        </p>
      )}
```

- [ ] **Step 10: Fix `replaceState` so it cannot unbind the draft**

Replace the effect at lines 274-277 with:

```tsx
  useEffect(() => {
    if (items.length === 0) return; // `?items=` empty would notFound() on reload
    const qs = new URLSearchParams({ items: items.map((i) => i.itemId).join(",") });
    // Keep the draft binding in the URL. Dropping it here is not cosmetic: an
    // iOS tab reload — the very scenario this effect exists to survive — would
    // silently unbind the draft, and the next "Save draft" would create a
    // SECOND draft instead of updating the first. `draftId` is state, so this
    // also picks up the id returned by the first save on a fresh builder.
    if (draftId) qs.set("draft", draftId);
    window.history.replaceState(null, "", `?${qs}`);
  }, [items, draftId]);
```

- [ ] **Step 11: Add the resume cases to the component test**

Append to `ReceiptBuilderForm.drafts.test.tsx`:

```tsx
import { receiptDraftSchema } from "@/modules/receipts/drafts.schema";

describe("resuming a draft", () => {
  const values = receiptDraftSchema.parse({
    itemIds: ["i1"],
    receiver: { name: "Doe, Jane", unit: "A Co" },
    returnDays: "7",
  });

  it("tells the operator they must sign again", () => {
    render(<ReceiptBuilderForm initialItems={ITEMS} signatures={[]} draftId="d1" draftValues={values} />);
    expect(screen.getByText(/please sign again/i)).toBeTruthy();
  });

  it("restores the typed recipient and return timer", () => {
    const { container } = render(<ReceiptBuilderForm initialItems={ITEMS} signatures={[]} draftId="d1" draftValues={values} />);
    expect((container.querySelector('input[name="receiverName"]') as HTMLInputElement).value).toBe("Doe, Jane");
    expect((container.querySelector('input[name="returnDays"]') as HTMLInputElement).value).toBe("7");
  });

  it("warns when items were dropped as no longer available", () => {
    render(<ReceiptBuilderForm initialItems={ITEMS} signatures={[]} draftId="d1" draftValues={values} droppedItemCount={2} />);
    expect(screen.getByText(/2 devices from this draft/i)).toBeTruthy();
  });

  it("shows no restore notice on a fresh builder", () => {
    render(<ReceiptBuilderForm initialItems={ITEMS} signatures={[]} />);
    expect(screen.queryByText(/please sign again/i)).toBeNull();
  });
});
```

- [ ] **Step 12: Run all the builder tests**

Run: `npx vitest run src/app/receipts/new/`
Expected: PASS

- [ ] **Step 13: Commit**

```bash
git add src/app/receipts/new src/modules/receipts/drafts.resume.ts
git commit -m "feat: resume a saved hand receipt draft"
```

---

## Task 8: Filing a receipt deletes its draft

**Files:**
- Modify: `src/app/actions/receipts.ts:17-123`
- Test: `src/app/actions/receipts.drafts.test.ts`

**Interfaces:**
- Consumes: `deleteDraft` (Task 3).

- [ ] **Step 1: Write the failing test**

Create `src/app/actions/receipts.drafts.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const requireUser = vi.fn();
const createTransfer = vi.fn();
const deleteDraft = vi.fn();

vi.mock("@/lib/authz", () => ({ requireUser: () => requireUser(), AuthError: class extends Error {} }));
vi.mock("@/modules/transfers/transfers.service", () => ({
  createTransfer: (...a: unknown[]) => createTransfer(...a),
  getTransferByReceiptNumber: vi.fn().mockResolvedValue({ lines: [] }),
}));
vi.mock("@/modules/receipts/drafts.service", () => ({ deleteDraft: (...a: unknown[]) => deleteDraft(...a) }));
vi.mock("@/modules/receipts/send-receipt-email", () => ({ sendReceiptEmails: vi.fn() }));
vi.mock("@/modules/receipts/render", () => ({ renderReceiptPdf: vi.fn() }));
vi.mock("@/modules/items/qr", () => ({ receiptLinkUrl: vi.fn().mockResolvedValue("http://x") }));
vi.mock("@/modules/service-queue/service-queue.service", () => ({ upsertServiceRequest: vi.fn() }));

import { createReceiptAction } from "./receipts";

function validForm(extra: [string, string][] = []): FormData {
  const fd = new FormData();
  fd.append("itemId", "i1");
  fd.append("line[0][make]", "Dell");
  fd.append("line[0][model]", "5420");
  fd.append("line[0][qtyAuth]", "1");
  fd.append("line[0][qtyIssued]", "1");
  fd.append("senderIsDcsim", "on");
  fd.append("senderName", "SGT Smith");
  fd.append("receiverName", "Doe, Jane");
  fd.append("receiverUnit", "A Co");
  fd.append("receiverContact", "8085551234");
  fd.append("receiverEmail", "jane@unit.mil");
  fd.append("receiverSignature", "data:image/png;base64,AAAA");
  for (const [k, v] of extra) fd.append(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireUser.mockResolvedValue({ id: "u1", role: "USER" });
  createTransfer.mockResolvedValue({ id: "t1", receiptNumber: "HR-000001" });
});

describe("createReceiptAction draft cleanup", () => {
  it("deletes the draft it was filed from, scoped to the acting user", async () => {
    const r = await createReceiptAction(undefined, validForm([["draftId", "d1"]]));
    expect(r).toMatchObject({ receiptNumber: "HR-000001" });
    expect(deleteDraft).toHaveBeenCalledWith("d1", "u1");
  });

  it("does nothing when the receipt was not filed from a draft", async () => {
    await createReceiptAction(undefined, validForm());
    expect(deleteDraft).not.toHaveBeenCalled();
  });

  it("still reports success when the cleanup fails — the receipt already exists", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    deleteDraft.mockRejectedValueOnce(new Error("db down"));
    const r = await createReceiptAction(undefined, validForm([["draftId", "d1"]]));
    expect(r).toMatchObject({ receiptNumber: "HR-000001" });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("does not delete the draft when the receipt fails to create", async () => {
    createTransfer.mockRejectedValueOnce(new Error("nope"));
    await createReceiptAction(undefined, validForm([["draftId", "d1"]]));
    expect(deleteDraft).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/app/actions/receipts.drafts.test.ts`
Expected: FAIL — `deleteDraft` never called

- [ ] **Step 3: Wire the cleanup in**

In `src/app/actions/receipts.ts`, add the import after line 14:

```ts
import { deleteDraft } from "@/modules/receipts/drafts.service";
```

Inside the `try` block, immediately after `receiptNumber = t.receiptNumber;`
(line 83):

```ts
    // The receipt is filed, so its draft has served its purpose. Best-effort
    // in the same style as the email block below: the receipt already exists
    // and is authoritative, so a failed cleanup is logged, never surfaced as a
    // failed receipt. A stale draft is harmless; a receipt that reports failure
    // after being filed is not.
    const draftId = String(formData.get("draftId") ?? "").trim();
    if (draftId) {
      try {
        await deleteDraft(draftId, user.id);
      } catch (err) {
        console.error(`[createReceiptAction] draft cleanup failed for ${draftId}:`, err);
      }
    }
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/app/actions/receipts.drafts.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Run the existing receipt action tests**

Run: `npx vitest run src/app/actions/receipts.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/app/actions/receipts.ts src/app/actions/receipts.drafts.test.ts
git commit -m "feat: delete a draft once its receipt is filed"
```

---

## Task 9: The account page drafts card

**Files:**
- Create: `src/app/account/DraftList.tsx`
- Modify: `src/app/account/page.tsx`
- Test: `src/app/account/DraftList.test.tsx`

**Interfaces:**
- Consumes: `listDrafts` (Task 3), `deleteDraftAction` (Task 5).
- Produces: `DraftList({ drafts }: { drafts: { id: string; label: string; updatedAt: Date }[] })`.

- [ ] **Step 1: Write the failing test**

Create `src/app/account/DraftList.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/app/actions/drafts", () => ({ deleteDraftAction: vi.fn() }));

import { DraftList } from "./DraftList";

const DRAFTS = [
  { id: "d1", label: "Doe, Jane · 2 items", updatedAt: new Date("2026-08-06T09:00:00Z") },
  { id: "d2", label: "No recipient yet · 1 item", updatedAt: new Date("2026-08-01T09:00:00Z") },
];

describe("DraftList", () => {
  it("shows an empty state when there are none", () => {
    render(<DraftList drafts={[]} />);
    expect(screen.getByText(/no saved drafts/i)).toBeTruthy();
  });

  it("lists each draft's label", () => {
    render(<DraftList drafts={DRAFTS} />);
    expect(screen.getByText("Doe, Jane · 2 items")).toBeTruthy();
    expect(screen.getByText("No recipient yet · 1 item")).toBeTruthy();
  });

  it("links Resume to the builder with the draft id", () => {
    render(<DraftList drafts={DRAFTS} />);
    const link = screen.getAllByRole("link", { name: /resume/i })[0] as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/receipts/new?draft=d1");
  });

  it("posts the draft id to the delete action", () => {
    const { container } = render(<DraftList drafts={DRAFTS} />);
    const hidden = container.querySelector('input[name="id"]') as HTMLInputElement;
    expect(hidden.value).toBe("d1");
  });

  it("gives each delete button an accessible name naming its draft", () => {
    render(<DraftList drafts={DRAFTS} />);
    expect(screen.getByRole("button", { name: /delete draft doe, jane/i })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/app/account/DraftList.test.tsx`
Expected: FAIL — cannot resolve `./DraftList`

- [ ] **Step 3: Write the component**

Create `src/app/account/DraftList.tsx`:

```tsx
import { deleteDraftAction } from "@/app/actions/drafts";

// A server component: there is no client state here. Delete is a plain form
// posting to a Server Action, deliberately NOT a confirmation `<dialog>` — a
// draft is low-stakes and recoverable by retyping, and this app has a
// documented trap where a layout class on a `<dialog>` defeats the UA's
// `dialog:not([open])` rule and renders every closed dialog.
//
// Mirrors SignatureManager's list shape (ul.stack-sm > li.row + .spacer) so the
// two cards on this page read the same. `.row` wraps, so on a phone the label
// and the two actions stack instead of colliding.
export function DraftList({ drafts }: {
  drafts: { id: string; label: string; updatedAt: Date }[];
}) {
  if (drafts.length === 0) {
    return <p className="subtle">No saved drafts. Use “Save draft” on a new hand receipt to keep one here.</p>;
  }
  return (
    <ul className="stack-sm">
      {drafts.map((d) => (
        <li key={d.id} className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <div>
            <strong>{d.label}</strong>
            <div className="subtle" style={{ fontSize: 12 }}>
              Saved {d.updatedAt.toLocaleString()}
            </div>
          </div>
          <span className="spacer" />
          <a
            className="btn btn-secondary btn-sm"
            style={{ minHeight: "var(--tap)" }}
            href={`/receipts/new?draft=${d.id}`}
          >
            Resume
          </a>
          <form action={deleteDraftAction}>
            <input type="hidden" name="id" value={d.id} />
            <button
              type="submit"
              className="btn btn-ghost btn-sm"
              style={{ minHeight: "var(--tap)" }}
              aria-label={`Delete draft ${d.label}`}
            >
              Delete
            </button>
          </form>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 4: Add the card to the account page**

In `src/app/account/page.tsx`, add the imports:

```tsx
import { listDrafts } from "@/modules/receipts/drafts.service";
import { DraftList } from "./DraftList";
```

Add `listDrafts(user.id)` to the existing `Promise.all` (lines 20-23):

```tsx
  const [me, signatures, drafts] = await Promise.all([
    isAdmin ? Promise.resolve(null) : prisma.user.findUnique({ where: { id: user.id }, select: { signatureImage: true } }),
    isAdmin ? listSignatureNames(user.id) : Promise.resolve([]),
    listDrafts(user.id),
  ]);
```

And render a card between the Signature and Change password cards:

```tsx
        <div className="card stack">
          <div className="card__title">Draft hand receipts</div>
          <p className="subtle">
            In-progress receipts you saved from the builder. Resuming one restores what you
            typed — the signature is never saved, so you sign again before filing. Drafts are
            private to you and are removed automatically after 30 days.
          </p>
          <DraftList drafts={drafts} />
        </div>
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/app/account/DraftList.test.tsx`
Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

```bash
git add src/app/account/DraftList.tsx src/app/account/DraftList.test.tsx src/app/account/page.tsx
git commit -m "feat: list saved hand receipt drafts on the account page"
```

---

## Task 10: Documentation and the security guardrail

**Files:**
- Modify: `scripts/check-security-docs.mjs` (the `WATCHED` array, ~line 35)
- Modify: `scripts/check-security-docs.test.mjs` (the `introducedThisBranch` array, ~line 24)
- Modify: `docs/SECURITY.md`
- Modify: `CLAUDE.md` (authorization section §1)
- Modify: `CHANGELOG.md`

**This task is not optional.** The `Security docs current` CI job is a required check on `main` and will fail the PR without it.

- [ ] **Step 1: Add the two files to the watch list**

In `scripts/check-security-docs.mjs`, inside `WATCHED`:

```js
  // Drafts are the one PRIVATE, owner-scoped surface in an otherwise
  // org-shared app, and they hold party PII (names, ranks, units, phone
  // numbers, emails) with no signature. The userId scoping IS the control —
  // an unwatched change to either file could quietly turn a personal draft
  // into a shared one, or drop the scope from a query.
  [/^src\/modules\/receipts\/drafts\.service\.ts$/, "owner-scoped draft storage (§2)"],
  [/^src\/app\/actions\/drafts\.ts$/, "draft save/delete actions (§2)"],
  // The parser is what DROPS the recipient signature before anything is
  // stored. A change here could start persisting ink without touching either
  // file above.
  [/^src\/modules\/receipts\/drafts\.form\.ts$/, "keeps signatures out of stored drafts (§2)"],
```

- [ ] **Step 2: Pin them in the watch-list test**

In `scripts/check-security-docs.test.mjs`, add to `introducedThisBranch`:

```js
    // Hand receipt drafts: the only owner-scoped (non-role-gated) surface in
    // the app, holding party PII.
    "src/modules/receipts/drafts.service.ts",
    "src/app/actions/drafts.ts",
    "src/modules/receipts/drafts.form.ts",
```

- [ ] **Step 3: Run the watch-list test**

Run: `npx vitest run scripts/check-security-docs.test.mjs`
Expected: PASS

- [ ] **Step 4: Add the control to `docs/SECURITY.md`**

Add a subsection under the authorization section, and bump the file's
*Last reviewed* date to `2026-08-06`:

```markdown
### Hand receipt drafts (owner-scoped)

`ReceiptDraft` rows are **private to the user who saved them** — the only
owner-scoped surface in an otherwise role-gated, org-shared application.

- **Why an exception.** A filed receipt is a shared organizational record; a
  half-typed builder form is personal working state. One technician resuming
  another's partly-entered handoff is confusing, and the row has none of the
  signature that makes a filed receipt a document.
- **How it is enforced.** `src/modules/receipts/drafts.service.ts` puts
  `userId` in the WHERE clause of every query (`findFirst` / `updateMany` /
  `deleteMany`), so a foreign or forged id touches zero rows rather than
  throwing. `src/app/actions/drafts.ts` takes the id from `requireUser()` and
  never from client input. `/receipts/new?draft=<id>` 404s on a draft the
  caller does not own.
- **Data held.** Both parties' name, rank, unit, contact number and email, the
  item ids, quantities, return timer, and service selections. **No signature is
  ever stored** — the payload schema has no such field and strips unknown keys,
  and `saveDraftAction` drops it explicitly.
- **Bounds.** `receiptDraftSchema` caps every string and both arrays before
  anything reaches the untyped `payload` Json column; 25 drafts per user.
- **Retention.** Deleted when its receipt is filed, on demand from `/account`,
  or automatically 30 days after last update by the nightly
  `/api/cron/purge` sweep. Cascade-deleted with the user account.

Add to **Known gaps & accepted risks**: a draft is readable by anyone holding
the author's live session, exactly like the rest of the signed-in surface; there
is no separate re-authentication to open one.
```

- [ ] **Step 5: Record the ownership exception in `CLAUDE.md`**

In the authorization section (§1), after the bullet beginning "Never gate a
capability on...", add:

```markdown
- **ONE owner-scoped exception: hand receipt drafts.** `ReceiptDraft` is private
  to its author — `src/modules/receipts/drafts.service.ts` scopes every query by
  `userId`. This is deliberate and is NOT the ownership pattern banned above: a
  filed receipt is a shared org record, but a half-typed builder form is personal
  working state. Do not "correct" it to role-based sharing, and do not copy the
  pattern to items, receipts or the queue. The signature is never stored in a
  draft (a signature attests to a specific item list, which a draft can change),
  and both files are on the `check-security-docs` watch list.
```

- [ ] **Step 6: Add the changelog entry**

At the top of `CHANGELOG.md`, under a `## 2026-08-06` heading (create it if the
newest section is older):

```markdown
### Added

- **Save a hand receipt as a draft.** The new receipt builder has a "Save draft"
  button beside its title. It stores everything you have entered — items, both
  parties, quantities, the return timer and any service flags — so an
  interrupted handoff no longer has to be retyped. Saved drafts appear under
  **Account → Draft hand receipts**, where you can resume or delete them.
  Drafts are private to you.
- Resuming a draft restores your typed work and warns you if any of its devices
  have since been retired or removed from inventory, keeping the rest.

### Security

- A recipient signature is **never** saved in a draft. A signature attests to a
  specific list of items, and a draft's list can change, so a resumed draft must
  be signed again before it can be filed.

### Notes

- New table `ReceiptDraft` (migration `20260806120000_add_receipt_draft`) —
  apply to Supabase **before** merging, per the migrate-before-push rule.
- Drafts are deleted automatically 30 days after they were last saved, by the
  existing nightly `/api/cron/purge` job. No new environment variables.
```

- [ ] **Step 7: Verify the guardrail passes locally**

Run: `npm run check:security-docs`
Expected: PASS (it sees `docs/SECURITY.md` in the same range as the watched files)

- [ ] **Step 8: Commit**

```bash
git add scripts/check-security-docs.mjs scripts/check-security-docs.test.mjs docs/SECURITY.md CLAUDE.md CHANGELOG.md
git commit -m "docs: record the draft surface in SECURITY.md, CLAUDE.md and the changelog"
```

---

## Task 11: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Lint**

Run: `npm run lint`
Expected: 0 errors (pre-existing warnings are acceptable; no NEW warnings from these files)

- [ ] **Step 2: Types**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Full test suite**

Run: `npm test`
Expected: PASS.

**Before running this, confirm no other agent or session is running tests** —
the suite truncates a shared test database, and two concurrent runs corrupt each
other's fixtures, which surfaces as failures in unrelated files.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: success.

Note: a green build is NOT evidence for any of the CSS/layout work in Step 5 —
`next build` has no layout engine.

- [ ] **Step 5: Browser verification (required)**

Start the dev server (`npm run dev`) and, signed in as a technician:

1. **Desktop, 1440px** — open `/items`, select 3 devices, "Create hand receipt".
   Confirm "Save draft" sits at the **top right, level with the title**.
2. Type a recipient, set quantities, set a 7-day return timer. Click **Save
   draft**. Confirm the success notice and that the URL has gained `&draft=`.
3. Open `/account`. Confirm the "Draft hand receipts" card lists it with the
   recipient name and item count.
4. **Resume** it. Confirm the recipient, quantities and return timer are
   restored, the signature pad is **empty**, and the "please sign again" notice
   is shown.
5. Sign and file the receipt. Confirm the receipt is created **and the draft is
   gone** from `/account`.
6. **Phone, 390px** (device toolbar or a real phone via the cloudflared tunnel):
   confirm the Save draft button wraps below the title rather than crushing it,
   that it is at least 44px tall, and that the `/account` draft rows stack
   readably with both actions reachable.
7. Save a draft, then retire one of its devices from `/admin/items/<id>/edit`.
   Resume the draft and confirm the warning names the dropped device and the
   remaining items still load.

- [ ] **Step 6: Report results**

Report each of the seven browser checks explicitly as pass/fail with what was
observed. Do not report the feature complete on the strength of the test suite
alone — steps 1, 6 and 7 are the ones nothing else in this plan can catch.
