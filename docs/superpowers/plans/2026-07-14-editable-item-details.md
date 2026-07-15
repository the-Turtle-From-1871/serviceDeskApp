# Editable Item Details + Edit History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any authenticated user edit an item's Home unit, Device Name, Current user, and Current position from an Edit button on the item detail card, with every change recorded in a new `ItemEdit` history table.

**Architecture:** Two new nullable `Item` columns plus an `ItemEdit` history table. A single shared `updateItemFields` service computes a diff and writes the update + one history row in a transaction; both the new user-level action and the existing admin action route through it, differing only in their auth guard and permitted field set. The item card gains an inline edit form with a `<datalist>`-backed unit picker.

**Tech Stack:** Next.js 16 (App Router, Server Components/Actions), React 19, Prisma 7 over PostgreSQL, Zod, Vitest, TypeScript 5.

## Global Constraints

- **Auth first in every Server Action:** `requireUser()` for the user-level action, `requireAdmin()` for admin actions (`src/lib/authz.ts`). `SessionUser = { id, role, name, email }` — `name` is available and is what `editedByName` records.
- **No ownership filter.** Inventory is shared org-wide; there is no per-user ownership model. Do NOT invent one.
- Zod-validate all form input before use. Return **generic** error strings to the client; `console.error` details server-side.
- Standard Prisma methods only — no raw SQL or string interpolation.
- **No new npm packages.** (No jsdom/testing-library exists — do NOT write React component tests.)
- **Test conventions — this module uses REAL-DB integration tests.** `src/modules/items/*.test.ts` and `units.service.test.ts` call `migrateTestDb()` in `beforeAll` and `resetDb()` in `beforeEach`, then hit the real `handreceipt_test` database via `@/lib/prisma` (they do NOT mock Prisma — unlike `transfers.service.test.ts`). Follow the real-DB pattern for service tests. Pure-logic files get plain unit tests with no DB.
  - `migrateTestDb()` runs `prisma migrate deploy` against the test DB, so a new migration is applied to `handreceipt_test` automatically when tests run. No manual test-DB step.
  - `resetDb()` truncates `"Transfer","Item","User","Unit"` **CASCADE**, so `ItemEdit` (FK → Item, `onDelete: Cascade`) is truncated automatically. Do NOT edit `tests/helpers/db.ts`.
- **`prisma migrate dev` CANNOT run in this environment** (Prisma 7.8 hard-fails non-interactively, no bypass). Author migrations with `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`, save into a hand-made `prisma/migrations/<timestamp>_<name>/migration.sql`, then `npx prisma migrate deploy` + `npx prisma generate`.
- Run a single test file with `npx vitest run <path>`. Full gates: `npx vitest run`, `npm run lint` (0 errors; ~19 pre-existing warnings in unrelated test files are expected), `npm run build`.
- Do NOT touch production. This plan is local-only; the prod migration is a separate, explicitly-confirmed step.

---

## File Structure

**Prisma**
- Modify: `prisma/schema.prisma` — `Item.currentUser`, `Item.currentPosition`, `Item.edits`; new `ItemEdit` model; `User.itemEdits`.
- Create: `prisma/migrations/<ts>_item_details_and_edit_history/migration.sql`.

**Items module** (`src/modules/items/`)
- Create: `item-diff.ts` (+ `item-diff.test.ts`) — pure `ItemLoggedFields`, `FieldChange`, `diffItemFields`. No Prisma import.
- Create: `items.errors.ts` — `ItemError` (mirrors `service-queue.errors.ts`).
- Modify: `items.service.ts` — add `updateItemFields`; **remove** the superseded `updateItem`.
- Modify: `items.service.test.ts` — replace the `updateItem` test with `updateItemFields` coverage (real DB).
- Modify: `items.schema.ts` — add `itemDetailsSchema`.
- Create: `items.schema.test.ts` — schema behavior (pure).
- Modify: `units.service.ts` — add `listUnits`.
- Modify: `units.service.test.ts` — add a `listUnits` test (real DB).

**Actions**
- Create: `src/app/actions/items.ts` — `updateItemDetailsAction` (user-level; sibling of `src/app/actions/receipts.ts`).
- Modify: `src/app/admin/actions/items.ts` — `updateItemAction` routes through `updateItemFields`.

**UI**
- Create: `src/app/i/[itemId]/ItemDetailsCard.tsx` — client component owning the view/edit toggle, the Edit button, and the form.
- Modify: `src/app/i/[itemId]/page.tsx` — fetch units + latest edit, render `ItemDetailsCard`, relabel the derived holder row.

**Audit**
- Modify: `src/app/admin/audit/page.tsx` — "Item edits" section.

---

## Task 1: Prisma schema + migration

**Files:**
- Modify: `prisma/schema.prisma` (`Item` model ~line 60, `User` model ~line 14)
- Create: `prisma/migrations/<timestamp>_item_details_and_edit_history/migration.sql`

**Interfaces:**
- Produces: `Item.currentUser: string | null`, `Item.currentPosition: string | null`; model `ItemEdit { id, itemId, editedById (nullable), editedByName, changes (Json), createdAt }`; relations `Item.edits`, `User.itemEdits`.

- [ ] **Step 1: Add the two `Item` columns and the back-relation**

In `prisma/schema.prisma`, inside `model Item`, add after the `notes` line:

```prisma
  // The person actually using the device, and their role/billet. Distinct from
  // the hand-receipt holder (derived from the latest OPEN Transfer), which stays
  // the signed custody record and is never edited here.
  currentUser     String?
  currentPosition String?
```

And add this to the same model's relation list (next to `transferItems`):

```prisma
  edits            ItemEdit[]
```

- [ ] **Step 2: Add the `User` back-relation**

In `model User`, add to its relation list (next to `createdItems`):

```prisma
  itemEdits        ItemEdit[]           @relation("ItemEdits")
```

- [ ] **Step 3: Add the `ItemEdit` model**

Append to `prisma/schema.prisma`:

```prisma
// History of edits to an Item's loggable fields. One row per save that actually
// changed something (a no-op save writes nothing).
model ItemEdit {
  id           String   @id @default(cuid())
  item         Item     @relation(fields: [itemId], references: [id], onDelete: Cascade)
  itemId       String
  // Nullable + SetNull, with a denormalized name snapshot, so history survives
  // the editor's account being deleted (mirrors ReturnTransaction.processedBy*).
  editedBy     User?    @relation("ItemEdits", fields: [editedById], references: [id], onDelete: SetNull)
  editedById   String?
  editedByName String
  // [{ field, from, to }] — only the fields that changed.
  changes      Json
  createdAt    DateTime @default(now())

  @@index([itemId])
  @@index([createdAt])
}
```

- [ ] **Step 4: Generate the migration SQL**

Run: `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`
Expected: DDL adding `currentUser`/`currentPosition` to `"Item"`, creating table `"ItemEdit"`, its indexes, and two foreign keys.

- [ ] **Step 5: Save it as a migration**

Create the folder `prisma/migrations/<timestamp>_item_details_and_edit_history/` (use a UTC timestamp that sorts after the existing migrations, e.g. `date -u +%Y%m%d%H%M%S`) and save the Step 4 output verbatim as `migration.sql` in it.

- [ ] **Step 6: Apply and generate**

Run: `npx prisma migrate deploy`
Expected: `All migrations have been successfully applied.`
Run: `npx prisma generate`
Run: `npx prisma migrate status`
Expected: `Database schema is up to date!`

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(items): currentUser/currentPosition + ItemEdit history schema"
```

---

## Task 2: Pure field-diff logic

**Files:**
- Create: `src/modules/items/item-diff.ts`
- Test: `src/modules/items/item-diff.test.ts`

**Interfaces:**
- Produces:
  - `type ItemLoggedFields = { homeUnit, deviceName, currentUser, currentPosition, make, model, serialNumber, notes }` (all `string | null`)
  - `type FieldChange = { field: keyof ItemLoggedFields; from: string | null; to: string | null }`
  - `diffItemFields(before: Partial<ItemLoggedFields>, after: Partial<ItemLoggedFields>): FieldChange[]`

- [ ] **Step 1: Write the failing test**

Create `src/modules/items/item-diff.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { diffItemFields } from "./item-diff";

describe("diffItemFields", () => {
  it("returns only the fields that actually changed", () => {
    expect(
      diffItemFields(
        { deviceName: "L-1", homeUnit: "A Co", currentUser: null },
        { deviceName: "L-2", homeUnit: "A Co" },
      ),
    ).toEqual([{ field: "deviceName", from: "L-1", to: "L-2" }]);
  });

  it("is empty for a no-op save", () => {
    expect(diffItemFields({ deviceName: "L-1" }, { deviceName: "L-1" })).toEqual([]);
  });

  it("ignores keys absent from `after` — that is not a clear-to-null", () => {
    expect(diffItemFields({ deviceName: "L-1", notes: "keep" }, { deviceName: "L-1" })).toEqual([]);
  });

  it("skips keys explicitly set to undefined in `after`", () => {
    expect(diffItemFields({ deviceName: "L-1" }, { deviceName: undefined })).toEqual([]);
  });

  it("treats blank, whitespace and null as equivalent (no change)", () => {
    expect(diffItemFields({ currentUser: null }, { currentUser: "   " })).toEqual([]);
    expect(diffItemFields({ currentUser: "" }, { currentUser: null })).toEqual([]);
  });

  it("trims before comparing and records the trimmed value", () => {
    expect(
      diffItemFields({ currentUser: "SGT Smith" }, { currentUser: "  SGT Jones  " }),
    ).toEqual([{ field: "currentUser", from: "SGT Smith", to: "SGT Jones" }]);
  });

  it("records a clear-to-null when the new value is blank", () => {
    expect(
      diffItemFields({ currentPosition: "Supply Sergeant" }, { currentPosition: "" }),
    ).toEqual([{ field: "currentPosition", from: "Supply Sergeant", to: null }]);
  });

  it("records multiple changes", () => {
    expect(
      diffItemFields(
        { currentUser: null, currentPosition: null },
        { currentUser: "SPC Lin", currentPosition: "S6" },
      ),
    ).toEqual([
      { field: "currentUser", from: null, to: "SPC Lin" },
      { field: "currentPosition", from: null, to: "S6" },
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/modules/items/item-diff.test.ts`
Expected: FAIL — "Cannot find module './item-diff'".

- [ ] **Step 3: Implement `item-diff.ts`**

Create `src/modules/items/item-diff.ts`:

```typescript
// Pure diff logic for item edits. No Prisma runtime import, so this is
// unit-testable without a database.

// Every field whose changes are recorded in ItemEdit. Callers pass any subset:
// the user-facing card edits four of them, the admin form edits six.
export type ItemLoggedFields = {
  homeUnit: string | null;
  deviceName: string | null;
  currentUser: string | null;
  currentPosition: string | null;
  make: string | null;
  model: string | null;
  serialNumber: string | null;
  notes: string | null;
};

export type FieldChange = {
  field: keyof ItemLoggedFields;
  from: string | null;
  to: string | null;
};

// Canonical stored form: trimmed, with blank/whitespace collapsed to null.
function norm(v: string | null | undefined): string | null {
  const trimmed = (v ?? "").trim();
  return trimmed || null;
}

/** Changes between `before` and the caller-supplied `after` subset.
 *  Keys absent from `after` (or explicitly undefined) are left alone — that is a
 *  "not submitted", never a clear-to-null. Returns only fields whose normalized
 *  value actually differs, so a no-op save produces an empty array. */
export function diffItemFields(
  before: Partial<ItemLoggedFields>,
  after: Partial<ItemLoggedFields>,
): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const field of Object.keys(after) as (keyof ItemLoggedFields)[]) {
    if (after[field] === undefined) continue;
    const from = norm(before[field]);
    const to = norm(after[field]);
    if (from !== to) changes.push({ field, from, to });
  }
  return changes;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/modules/items/item-diff.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/items/item-diff.ts src/modules/items/item-diff.test.ts
git commit -m "feat(items): pure field-diff for edit history"
```

---

## Task 3: `updateItemFields` service + remove `updateItem`

**Files:**
- Create: `src/modules/items/items.errors.ts`
- Modify: `src/modules/items/items.service.ts` (add `updateItemFields`; delete `updateItem` at ~line 49)
- Modify: `src/modules/items/items.service.test.ts` (replace the `updateItem` test at ~line 60)

**Interfaces:**
- Consumes: `diffItemFields`, `ItemLoggedFields` (Task 2); Prisma `ItemEdit` model (Task 1).
- Produces:
  - `class ItemError` with `code: "NOT_FOUND"`
  - `type ItemEditor = { id: string; name: string }`
  - `updateItemFields(itemId: string, data: Partial<ItemLoggedFields>, editor: ItemEditor): Promise<Item>`
- Removes: `updateItem` (superseded — its only callers were `updateItemAction` and its own test, both handled here/Task 5).

- [ ] **Step 1: Create the error type**

Create `src/modules/items/items.errors.ts`:

```typescript
export class ItemError extends Error {
  constructor(public code: "NOT_FOUND", message?: string) {
    super(message ?? code);
    this.name = "ItemError";
  }
}
```

- [ ] **Step 2: Write the failing tests (real DB)**

In `src/modules/items/items.service.test.ts`, replace the existing test at ~line 60:

```typescript
test("updateItem changes editable fields", async () => {
  const item = await createItem({ make: "M", model: "N", serialNumber: "S", ...base }, adminId);
  const updated = await updateItem(item.id, { homeUnit: "Cage 3" });
  expect(updated.homeUnit).toBe("Cage 3");
});
```

with these tests:

```typescript
test("updateItemFields changes fields and records one ItemEdit with the diff", async () => {
  const item = await createItem({ make: "M", model: "N", serialNumber: "S", ...base }, adminId);
  const updated = await updateItemFields(
    item.id,
    { homeUnit: "Cage 3", currentUser: "SGT Smith", currentPosition: "Supply Sergeant" },
    { id: adminId, name: "Admin" },
  );
  expect(updated.homeUnit).toBe("Cage 3");
  expect(updated.currentUser).toBe("SGT Smith");
  expect(updated.currentPosition).toBe("Supply Sergeant");

  const edits = await prisma.itemEdit.findMany({ where: { itemId: item.id } });
  expect(edits).toHaveLength(1);
  expect(edits[0].editedById).toBe(adminId);
  expect(edits[0].editedByName).toBe("Admin");
  expect(edits[0].changes).toEqual([
    { field: "homeUnit", from: null, to: "Cage 3" },
    { field: "currentUser", from: null, to: "SGT Smith" },
    { field: "currentPosition", from: null, to: "Supply Sergeant" },
  ]);
});

test("updateItemFields writes no history row for a no-op save", async () => {
  const item = await createItem({ make: "M", model: "N", serialNumber: "S", ...base }, adminId);
  await updateItemFields(item.id, { deviceName: "Radio" }, { id: adminId, name: "Admin" });
  expect(await prisma.itemEdit.count({ where: { itemId: item.id } })).toBe(0);
});

test("updateItemFields records only the fields that changed", async () => {
  const item = await createItem({ make: "M", model: "N", serialNumber: "S", ...base }, adminId);
  await updateItemFields(item.id, { deviceName: "Radio", currentUser: "SPC Lin" }, { id: adminId, name: "Admin" });
  const edit = await prisma.itemEdit.findFirstOrThrow({ where: { itemId: item.id } });
  expect(edit.changes).toEqual([{ field: "currentUser", from: null, to: "SPC Lin" }]);
});

test("updateItemFields clears a field when given a blank value", async () => {
  const item = await createItem({ make: "M", model: "N", serialNumber: "S", ...base }, adminId);
  await updateItemFields(item.id, { currentUser: "SPC Lin" }, { id: adminId, name: "Admin" });
  const cleared = await updateItemFields(item.id, { currentUser: "" }, { id: adminId, name: "Admin" });
  expect(cleared.currentUser).toBeNull();
});

test("updateItemFields throws NOT_FOUND for a missing item", async () => {
  await expect(
    updateItemFields("nope", { currentUser: "X" }, { id: adminId, name: "Admin" }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});
```

Update the import on line 4 of that file to drop `updateItem` and add `updateItemFields`:

```typescript
import { createItem, getItem, listItems, updateItemFields, retireItem, setItemStatus } from "./items.service";
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/modules/items/items.service.test.ts`
Expected: FAIL — `updateItemFields` is not exported.

- [ ] **Step 4: Implement `updateItemFields` and delete `updateItem`**

In `src/modules/items/items.service.ts`, add these imports at the top:

```typescript
import { diffItemFields, type ItemLoggedFields } from "./item-diff";
import { ItemError } from "./items.errors";
```

DELETE the existing `updateItem` function (~lines 49-52):

```typescript
export async function updateItem(id: string, input: Partial<NewItemInput>): Promise<Item> {
  const data = newItemSchema.partial().parse(input);
  return prisma.item.update({ where: { id }, data });
}
```

and add in its place:

```typescript
export type ItemEditor = { id: string; name: string };

/** Update an item's loggable fields and record ONE ItemEdit describing the diff,
 *  atomically. Writes no history row when nothing actually changed.
 *
 *  Enforces NO permissions and trusts `editor` — the calling Server Action owns
 *  the auth guard and the permitted field set. */
export async function updateItemFields(
  itemId: string,
  data: Partial<ItemLoggedFields>,
  editor: ItemEditor,
): Promise<Item> {
  return prisma.$transaction(async (tx) => {
    const before = await tx.item.findUnique({ where: { id: itemId } });
    if (!before) throw new ItemError("NOT_FOUND");

    const changes = diffItemFields(before, data);
    if (changes.length === 0) return before;

    const updated = await tx.item.update({
      where: { id: itemId },
      data: Object.fromEntries(changes.map((c) => [c.field, c.to])),
    });
    await tx.itemEdit.create({
      data: {
        itemId,
        editedById: editor.id,
        editedByName: editor.name,
        changes: changes as unknown as Prisma.InputJsonValue,
      },
    });
    return updated;
  });
}
```

`Prisma` is already imported as a type in this file (`import type { Item, ItemStatus, Prisma } from "@prisma/client"`), so `Prisma.InputJsonValue` resolves.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/modules/items/items.service.test.ts`
Expected: PASS — all tests in the file, including the 5 new ones.

- [ ] **Step 6: Commit**

```bash
git add src/modules/items/items.errors.ts src/modules/items/items.service.ts src/modules/items/items.service.test.ts
git commit -m "feat(items): updateItemFields writes an ItemEdit diff atomically"
```

---

## Task 4: Edit schema + unit list

**Files:**
- Modify: `src/modules/items/items.schema.ts`
- Create: `src/modules/items/items.schema.test.ts`
- Modify: `src/modules/items/units.service.ts`
- Modify: `src/modules/items/units.service.test.ts`

**Interfaces:**
- Produces:
  - `itemDetailsSchema` — Zod object over `{ deviceName, homeUnit, currentUser, currentPosition }`
  - `type ItemDetailsInput = z.infer<typeof itemDetailsSchema>`
  - `listUnits(): Promise<{ abbreviation: string; fullName: string }[]>`

- [ ] **Step 1: Write the failing schema test**

Create `src/modules/items/items.schema.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { itemDetailsSchema } from "./items.schema";

const base = { deviceName: "Laptop-9", homeUnit: "A Co", currentUser: "SGT Smith", currentPosition: "Supply" };

describe("itemDetailsSchema", () => {
  it("accepts the four fields and trims them", () => {
    const parsed = itemDetailsSchema.parse({ ...base, currentUser: "  SGT Smith  " });
    expect(parsed.currentUser).toBe("SGT Smith");
  });

  it("KEEPS blank values so they can clear a stored field", () => {
    // Regression guard: the `optional` helper used by newItemSchema drops "" to
    // undefined, which diffItemFields would skip — clearing would silently no-op.
    const parsed = itemDetailsSchema.parse({ ...base, currentUser: "", currentPosition: "   " });
    expect(parsed.currentUser).toBe("");
    expect(parsed.currentPosition).toBe("");
  });

  it("requires a device name", () => {
    expect(itemDetailsSchema.safeParse({ ...base, deviceName: "  " }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/modules/items/items.schema.test.ts`
Expected: FAIL — `itemDetailsSchema` is not exported.

- [ ] **Step 3: Add `itemDetailsSchema`**

Append to `src/modules/items/items.schema.ts`:

```typescript
// The fields any authenticated user may edit from the item detail card.
//
// NOTE: deliberately does NOT use the `optional` helper above. That helper maps
// "" -> undefined, and `diffItemFields` treats an undefined value as "not
// submitted" — so an emptied input would silently fail to clear the stored
// value. Keeping the blank string lets the diff record a clear-to-null.
const clearable = z.string().trim();

export const itemDetailsSchema = z.object({
  deviceName: z.string().trim().min(1, "Device name is required"),
  homeUnit: clearable,
  currentUser: clearable,
  currentPosition: clearable,
});

export type ItemDetailsInput = z.infer<typeof itemDetailsSchema>;
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/modules/items/items.schema.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing `listUnits` test (real DB)**

Append to `src/modules/items/units.service.test.ts`:

```typescript
test("listUnits returns abbreviation + fullName ordered by fullName", async () => {
  await prisma.unit.create({ data: { abbreviation: "ZED", fullName: "Zulu Company" } });
  await prisma.unit.create({ data: { abbreviation: "ALP", fullName: "Alpha Company" } });
  const units = await listUnits();
  expect(units).toEqual([
    { abbreviation: "ALP", fullName: "Alpha Company" },
    { abbreviation: "ZED", fullName: "Zulu Company" },
  ]);
});
```

and update that file's import on line 4:

```typescript
import { loadUnitMap, learnUnits, listUnits } from "./units.service";
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run src/modules/items/units.service.test.ts`
Expected: FAIL — `listUnits` is not exported.

- [ ] **Step 7: Add `listUnits`**

Append to `src/modules/items/units.service.ts`:

```typescript
// Units for the item-detail unit picker's <datalist>, ordered for display.
export function listUnits(): Promise<{ abbreviation: string; fullName: string }[]> {
  return prisma.unit.findMany({
    select: { abbreviation: true, fullName: true },
    orderBy: { fullName: "asc" },
  });
}
```

- [ ] **Step 8: Run it to verify it passes**

Run: `npx vitest run src/modules/items/units.service.test.ts`
Expected: PASS — including the new test.

- [ ] **Step 9: Commit**

```bash
git add src/modules/items/items.schema.ts src/modules/items/items.schema.test.ts src/modules/items/units.service.ts src/modules/items/units.service.test.ts
git commit -m "feat(items): itemDetailsSchema + listUnits for the detail editor"
```

---

## Task 5: Server actions (user-level + admin refactor)

**Files:**
- Create: `src/app/actions/items.ts`
- Modify: `src/app/admin/actions/items.ts` (imports at line 4; `updateItemAction` at lines 20-30)

**Interfaces:**
- Consumes: `updateItemFields`, `ItemEditor` (Task 3); `itemDetailsSchema` (Task 4); `ItemError` (Task 3); `requireUser`/`requireAdmin` returning `SessionUser = { id, role, name, email }`.
- Produces: `updateItemDetailsAction(_prev: unknown, formData: FormData): Promise<{ ok: true } | { error: string }>`.

- [ ] **Step 1: Create the user-level action**

Create `src/app/actions/items.ts`:

```typescript
"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/authz";
import { updateItemFields } from "@/modules/items/items.service";
import { itemDetailsSchema } from "@/modules/items/items.schema";
import { ItemError } from "@/modules/items/items.errors";

// Any ACTIVE authenticated user may edit an item's details — inventory is shared
// org-wide, so there is deliberately no ownership filter. Every change is
// recorded as an ItemEdit by updateItemFields.
export async function updateItemDetailsAction(_prev: unknown, formData: FormData) {
  const user = await requireUser();
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return { error: "Missing item." };

  const parsed = itemDetailsSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  try {
    await updateItemFields(id, parsed.data, { id: user.id, name: user.name });
  } catch (e) {
    if (e instanceof ItemError && e.code === "NOT_FOUND") {
      return { error: "That item no longer exists." };
    }
    console.error("[updateItemDetailsAction] unexpected error:", e);
    return { error: "Something went wrong saving your changes. Please try again." };
  }

  revalidatePath(`/i/${id}`);
  revalidatePath("/items");
  return { ok: true as const };
}
```

- [ ] **Step 2: Route the admin action through the same service**

In `src/app/admin/actions/items.ts`, change the import on line 4 (drop `updateItem`, keep the rest) and add the two new imports:

```typescript
import { createItem, updateItemFields, setItemStatus, analyzeImport, commitImport } from "@/modules/items/items.service";
import { ItemError } from "@/modules/items/items.errors";
```

Then replace `updateItemAction` (lines 20-30) with:

```typescript
// Admin edit of an item's identity fields. Routes through the SAME
// updateItemFields as the user-level action so admin changes land in the same
// ItemEdit history rather than bypassing it.
export async function updateItemAction(_prev: unknown, formData: FormData) {
  const admin = await requireAdmin();
  const id = String(formData.get("id"));
  const parsed = newItemSchema.partial().safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  try {
    await updateItemFields(id, parsed.data, { id: admin.id, name: admin.name });
  } catch (e) {
    if (e instanceof ItemError && e.code === "NOT_FOUND") {
      return { error: "That item no longer exists." };
    }
    console.error("[updateItemAction] unexpected error:", e);
    return { error: "Something went wrong saving your changes. Please try again." };
  }
  revalidatePath("/items");
  revalidatePath(`/i/${id}`);
  return { ok: true };
}
```

- [ ] **Step 3: Verify nothing still imports the deleted `updateItem`**

Run: `npx tsc --noEmit 2>&1 | grep -i "updateItem" || echo "no stale updateItem references"`
Expected: `no stale updateItem references`.

- [ ] **Step 4: Run the item module tests**

Run: `npx vitest run src/modules/items`
Expected: PASS (no regressions; the actions have no dedicated test file).

- [ ] **Step 5: Commit**

```bash
git add src/app/actions/items.ts src/app/admin/actions/items.ts
git commit -m "feat(items): user-level detail edit action; admin edits share the history path"
```

---

## Task 6: Item details card with inline edit

**Files:**
- Create: `src/app/i/[itemId]/ItemDetailsCard.tsx`
- Modify: `src/app/i/[itemId]/page.tsx` (imports 1-13; `Promise.all` 18-24; details card 44-68)

**Interfaces:**
- Consumes: `updateItemDetailsAction` (Task 5); `listUnits` (Task 4).
- Produces: `ItemDetailsCard` client component (props below).

- [ ] **Step 1: Create the client card**

Create `src/app/i/[itemId]/ItemDetailsCard.tsx`:

```tsx
"use client";
import { useActionState, useEffect, useState } from "react";
import { updateItemDetailsAction } from "@/app/actions/items";

export type ItemDetailsValues = {
  id: string;
  deviceName: string | null;
  homeUnit: string | null;
  currentUser: string | null;
  currentPosition: string | null;
  notes: string | null;
};

type Props = {
  item: ItemDetailsValues;
  isAdmin: boolean;
  units: { abbreviation: string; fullName: string }[];
  // Pre-formatted on the server so this component stays free of date/party logic.
  dateLogged: string;
  loggedBy: string;
  handReceiptHolder: string;
  lastEdited: string | null;
};

const dash = <span className="subtle">—</span>;

export function ItemDetailsCard({ item, isAdmin, units, dateLogged, loggedBy, handReceiptHolder, lastEdited }: Props) {
  const [editing, setEditing] = useState(false);
  const [state, action, pending] = useActionState(updateItemDetailsAction, undefined);

  // Leave edit mode once a save succeeds; the server re-renders with new values.
  // Keyed on `state` IDENTITY, not on a derived boolean: every successful submit
  // returns a fresh object, so a second save also closes the editor — while
  // merely re-opening the editor does not change `state`, so it stays open.
  // (A boolean dep, or setting state during render, would leave `ok` true
  // forever and slam the form shut every time Edit was clicked again.)
  useEffect(() => {
    if (state && "ok" in state && state.ok) setEditing(false);
  }, [state]);

  return (
    <div className="card">
      <div className="row">
        <div className="card__title">Item details</div>
        <span className="spacer" />
        {!editing && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
      </div>

      {editing ? (
        <form action={action} className="stack-sm">
          <input type="hidden" name="id" value={item.id} />
          <div className="form-grid">
            <div className="field">
              <label className="label" htmlFor="ed-deviceName">Device Name<span className="req"> *</span></label>
              <input id="ed-deviceName" className="input" name="deviceName" defaultValue={item.deviceName ?? ""} required />
            </div>
            <div className="field">
              <label className="label" htmlFor="ed-homeUnit">Home unit</label>
              <input
                id="ed-homeUnit"
                className="input"
                name="homeUnit"
                list="ed-units"
                autoComplete="off"
                placeholder="Search units…"
                defaultValue={item.homeUnit ?? ""}
              />
              <datalist id="ed-units">
                {units.map((u) => <option key={u.abbreviation} value={u.fullName}>{u.abbreviation}</option>)}
              </datalist>
            </div>
            <div className="field">
              <label className="label" htmlFor="ed-currentUser">Current user</label>
              <input id="ed-currentUser" className="input" name="currentUser" defaultValue={item.currentUser ?? ""} placeholder="e.g. SGT Smith" />
            </div>
            <div className="field">
              <label className="label" htmlFor="ed-currentPosition">Current position</label>
              <input id="ed-currentPosition" className="input" name="currentPosition" defaultValue={item.currentPosition ?? ""} placeholder="e.g. Supply Sergeant" />
            </div>
          </div>
          {state && "error" in state && state.error && <p role="alert" className="alert-error">{state.error}</p>}
          <div className="row">
            <button type="submit" className="btn btn-primary" disabled={pending}>
              {pending ? "Saving…" : "Save changes"}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setEditing(false)} disabled={pending}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <dl className="dl">
          <dt>Device Name</dt>
          <dd>{item.deviceName || dash}</dd>
          <dt>Home unit</dt>
          <dd>{item.homeUnit || dash}</dd>
          <dt>Current user</dt>
          <dd>{item.currentUser || dash}</dd>
          <dt>Current position</dt>
          <dd>{item.currentPosition || dash}</dd>
          {isAdmin && (
            <>
              <dt>Notes</dt>
              <dd>{item.notes || dash}</dd>
            </>
          )}
          <dt>Date logged</dt>
          <dd>{dateLogged}</dd>
          <dt>Logged by</dt>
          <dd>{loggedBy}</dd>
          <dt>Hand-receipt holder</dt>
          <dd>{handReceiptHolder}</dd>
          {lastEdited && (
            <>
              <dt>Last edited</dt>
              <dd className="subtle">{lastEdited}</dd>
            </>
          )}
        </dl>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Wire the page to it**

In `src/app/i/[itemId]/page.tsx`:

(a) Add these imports after the existing ones (line 13):

```tsx
import prisma from "@/lib/prisma";
import { listUnits } from "@/modules/items/units.service";
import { ItemDetailsCard } from "./ItemDetailsCard";
```

(b) Replace the `Promise.all` block (lines 17-24) with:

```tsx
  // All fetches depend only on itemId (known up front), so run them together.
  const [item, user, receipts, qr, service, units, lastEdit] = await Promise.all([
    getItemWithCreator(itemId),
    getCurrentUser(),
    listReceiptsForItem(itemId),
    itemQrDataUrl(itemId).catch((e) => { console.error("[item-page] QR generation failed:", e); return ""; }),
    getServiceRequestForItem(itemId),
    listUnits(),
    prisma.itemEdit.findFirst({ where: { itemId }, orderBy: { createdAt: "desc" } }),
  ]);
```

(c) Replace the whole `{loggedIn && ( ... )}` **Item details** card (lines 44-68) with:

```tsx
        {loggedIn && (
          <ItemDetailsCard
            item={{
              id: item.id,
              deviceName: item.deviceName,
              homeUnit: item.homeUnit,
              currentUser: item.currentUser,
              currentPosition: item.currentPosition,
              notes: item.notes,
            }}
            isAdmin={isAdmin}
            units={units}
            dateLogged={formatDateTimeHST(item.createdAt)}
            loggedBy={item.createdBy ? formatParty({ isDcsim: false, name: item.createdBy.name, rank: item.createdBy.rank, unit: null }) : "—"}
            handReceiptHolder={
              currentHolder
                ? formatParty({ isDcsim: currentHolder.receiverIsDcsim, name: currentHolder.receiverName, rank: currentHolder.receiverRank, unit: currentHolder.receiverUnit })
                : "Not yet transferred"
            }
            lastEdited={lastEdit ? `${lastEdit.editedByName} · ${formatDateTimeHST(lastEdit.createdAt)}` : null}
          />
        )}
```

- [ ] **Step 3: Verify build + lint**

Run: `npm run build`
Expected: compiles with no type errors.
Run: `npm run lint`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add "src/app/i/[itemId]/ItemDetailsCard.tsx" "src/app/i/[itemId]/page.tsx"
git commit -m "feat(items): inline edit on the item details card with unit picker"
```

---

## Task 7: Audit surface + final verification

**Files:**
- Modify: `src/app/admin/audit/page.tsx` (queries at lines 16-25; sections after line 60)

**Interfaces:**
- Consumes: Prisma `ItemEdit` (Task 1).

- [ ] **Step 1: Fetch recent item edits**

In `src/app/admin/audit/page.tsx`, add this after the `returns` query (line 25):

```tsx
  const itemEdits = await prisma.itemEdit.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { item: { select: { id: true, serialNumber: true, deviceName: true } } },
  });
```

- [ ] **Step 2: Render the section**

Insert this immediately after the closing `)}` of the `returns.length > 0 && (...)` block (after line 90), before the transfers `<div className="table-wrap">`:

```tsx
      {itemEdits.length > 0 && (
        <div className="stack-sm">
          <h2 className="card__title">Item edits</h2>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Date</th><th>By</th><th>Item</th><th>Changed</th></tr>
              </thead>
              <tbody>
                {itemEdits.map((e) => {
                  const changes = Array.isArray(e.changes)
                    ? (e.changes as unknown as { field: string; from: string | null; to: string | null }[])
                    : [];
                  return (
                    <tr key={e.id}>
                      <td className="subtle" data-label="Date">{formatDateTimeHST(e.createdAt)}</td>
                      <td data-label="By">{e.editedByName}</td>
                      <td data-label="Item">
                        <Link href={`/i/${e.item.id}`}>{e.item.deviceName || e.item.serialNumber}</Link>
                      </td>
                      <td data-label="Changed">
                        {changes.map((c) => (
                          <div key={c.field} className="subtle">
                            {c.field}: {c.from ?? "—"} → {c.to ?? "—"}
                          </div>
                        ))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
```

- [ ] **Step 3: Full green checkpoint**

Run: `npx vitest run`
Expected: all suites pass.
Run: `npm run build`
Expected: success.
Run: `npm run lint`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/app/admin/audit/page.tsx
git commit -m "feat(audit): item edit history section"
```

---

## Self-Review

**Spec coverage:**
- `currentUser` + `currentPosition` on Item → Task 1. ✓
- `ItemEdit` table w/ `editedByName` snapshot + SetNull → Task 1. ✓
- Any authenticated user may edit, no ownership filter → Task 5 (`requireUser`). ✓
- Edit button top-right of Item details card → Task 6 (title row + `spacer` + button). ✓
- Inline edit (no navigation) → Task 6 (`editing` state). ✓
- Home unit shown in the card (new) → Task 6. ✓
- "Current holder" renamed "Hand-receipt holder", stays derived/read-only → Task 6. ✓
- Current position = role/billet, free text → Tasks 1, 4, 6. ✓
- Unit searchable dropdown from Unit table via `<datalist>` → Tasks 4 (`listUnits`) + 6. ✓
- Shared write+log path; admin edits logged too → Tasks 3 + 5. ✓
- Diff logs only changed fields; no-op writes nothing → Tasks 2 + 3. ✓
- "Last edited by X on Y" on the card → Task 6. ✓
- `/admin/audit` "Item edits" section → Task 7. ✓
- Admin edit page left as-is → no task (deliberate). ✓
- Testing: pure diff + schema; real-DB service tests; no component tests → Tasks 2, 3, 4. ✓

**Placeholder scan:** No TBD/TODO. Every code step carries complete code; every test step carries real assertions. ✓

**Type consistency:** `ItemLoggedFields`/`FieldChange`/`diffItemFields` (Task 2) are consumed with identical names in Task 3. `updateItemFields(itemId, data, editor)` and `ItemEditor = { id, name }` are identical in Tasks 3 and 5. `itemDetailsSchema` field names (`deviceName`, `homeUnit`, `currentUser`, `currentPosition`) match the form `name=` attributes in Task 6 and the `ItemLoggedFields` keys in Task 2. `listUnits` returns `{ abbreviation, fullName }[]`, matching the `units` prop in Task 6. `ItemError`'s only code `"NOT_FOUND"` is the only one caught in Task 5. ✓

**Known follow-on (not in this plan):** applying this migration to production is a separate, explicitly-confirmed step — prod is out of scope here.
