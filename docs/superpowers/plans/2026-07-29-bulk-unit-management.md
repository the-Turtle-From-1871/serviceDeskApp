# Bulk Unit Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give admins one page to add, correct and remove unit abbreviations in bulk, so the automated import has somewhere to report what it could not resolve and somebody can fix it.

**Architecture:** A new `/admin/units` page mirroring the existing `/admin/categories` managed-vocabulary pattern. `Unit` is a standalone lookup (`abbreviation` → `fullName`) with no FK to `Item`; `Item.homeUnit` stores the *full name* denormalised. Renaming a unit therefore backfills every item carrying the old string, in one `updateMany`, logged to `ItemEdit`.

**Tech Stack:** Next.js 16 Server Components + Server Actions, Prisma 7, Zod, Vitest.

Spec: `docs/superpowers/specs/2026-07-29-automated-mdm-import-design.md` (§ "`/admin/units` — bulk unit management")

---

## ⚠️ STATUS: EXECUTED 2026-07-29/30 — read these corrections before reusing anything below

This plan shipped on `feat/bulk-unit-management`. **Several code snippets below are
wrong** and were corrected during execution. They are left in place so the record
matches what was actually planned, but do not copy them:

1. **`parseUnitBlock` CANNOT live in `src/app/admin/actions/units.ts`** (Task 4). That
   file starts with `"use server"`, and Next.js requires *every* export from such a
   module to be an async function — a synchronous export is a **build error**. It was
   moved to its own pure module, `src/modules/items/units.parse.ts`. Only
   `npm run build` catches this; vitest does not.
2. **`bulkLearnUnitsAction`'s return was dishonest** (Task 4). `{ created: units.length,
   updated: 0 }` reports lines *submitted*, not created, and `updated: 0` is false
   whenever an existing unit was re-taught. `learnUnits` was extended to return the real
   `{ created, updated }` it already computes internally. That changed its return type
   from `void`, which broke a pre-existing assertion.
3. **Every `prisma.user.findFirstOrThrow({ where: { role: "ADMIN" } })` in the test
   snippets always throws.** `tests/helpers/db.ts` `resetDb()` TRUNCATEs `User` before
   each test. Tests must create their own admin.
4. **The test snippets use `describe`/`it` with per-test `deleteMany`.** The real
   `units.service.test.ts` uses top-level `test()` with `beforeEach(resetDb)`, which
   already truncates. Follow the file.
5. **Task 3's `listUnitsWithCounts` snippet folds case in JS (`.toLowerCase()`) while
   `deleteUnit` compared exactly.** Three comparison sites that disagree is the exact
   bug this feature exists to prevent — the UI reported a unit as in use while the
   delete succeeded anyway. All sites now use one parameterized
   `LOWER(btrim(...))` comparison in SQL. **Consequence to know:** renaming a unit also
   normalises items whose home unit differed only in capitalisation.
6. **Task 6's page-local `isStale` helper was untested.** It was extracted to
   `src/modules/items/import-freshness.ts` with `now` as a required parameter and the
   threshold as an exported constant, mirroring `src/modules/timers/due.ts`.
7. **The spec claimed `homeUnit` needed adding to `ItemLoggedFields`.** It was already
   there (`item-diff.ts`); no type change was needed.

Two defects found only by a **real-browser** pass, which neither `npm run build` nor
jsdom caught — the reason this project insists on browser verification:

- The unresolved-devices panel showed the *capped array length* (50) as if it were the
  device count; 100 actually qualified. It now returns `{ items, total }`.
- JSX stripped the space after a `</strong>` tag, rendering "the next **timeit** is
  included". jsdom did not reproduce it. An explicit `{" "}` fixes it.

## Global Constraints

- Every Server Action and Route Handler starts with `requireUser()`/`requireAdmin()` from `@/lib/authz` — never bare `auth()`. This whole feature is `requireAdmin()`.
- **Never query inside a loop.** Bulk writes are a fixed number of queries in one transaction, shaped like `setItemsCategory` in `items.service.ts`: one `findMany` for before-values, one `createMany`/`updateMany` for the writes, one `createMany` of history rows.
- Values are bound in raw SQL, never interpolated. Identifiers come from an allowlist.
- Catch exceptions in Server Actions; return `{ error }` with a generic message, log detail server-side.
- Styling: this page uses the **existing `globals.css` ledger design system** (`.card`, `.stack`, `.btn`, `.table`, `.row`), matching `/admin/categories`. Do NOT introduce Tailwind here.
- Touch targets have a 44px floor (`--tap`).
- Docs update in the same commit: `CHANGELOG.md`, and `CLAUDE.md` where a rule changes.
- `prisma migrate dev` cannot run non-interactively. Use `migrate diff --from-config-datasource --to-schema` then `migrate deploy`.
- Do not run the test suite concurrently with another agent.

---

### Task 1: Make `Unit.abbreviation` case-insensitive

`abbreviation` is `@unique` but plain text, so the uppercase normalisation in `learnUnits` is convention-only. A write site that forgets creates `wabc01` alongside `WABC01`, and both resolve differently. `User.email` and `Item.serialNumber` already solve this with citext.

**Files:**
- Modify: `prisma/schema.prisma` (the `Unit` model)
- Create: `prisma/migrations/<timestamp>_unit_abbreviation_citext/migration.sql`
- Test: `src/modules/items/units.service.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Unit.abbreviation` is `@db.Citext`.

- [ ] **Step 1: Write the failing test**

Create `src/modules/items/units.service.test.ts` (or add to it if it exists):

```ts
import { describe, it, expect, beforeEach } from "vitest";
import prisma from "@/lib/prisma";
import { learnUnits, loadUnitMap } from "./units.service";

describe("Unit.abbreviation is case-insensitive", () => {
  beforeEach(async () => {
    await prisma.unit.deleteMany({ where: { abbreviation: { in: ["CITEST01", "citest01"] } } });
  });

  it("treats two casings of one abbreviation as the same row", async () => {
    await prisma.unit.create({ data: { abbreviation: "CITEST01", fullName: "First" } });
    await expect(
      prisma.unit.create({ data: { abbreviation: "citest01", fullName: "Second" } }),
    ).rejects.toThrow();
  });

  it("finds a unit regardless of the casing looked up", async () => {
    await prisma.unit.create({ data: { abbreviation: "CITEST01", fullName: "First" } });
    const found = await prisma.unit.findUnique({ where: { abbreviation: "citest01" } });
    expect(found?.fullName).toBe("First");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/modules/items/units.service.test.ts`
Expected: FAIL — the second create succeeds, and the lowercase lookup returns null.

- [ ] **Step 3: Change the schema**

In `prisma/schema.prisma`, the `Unit` model:

```prisma
model Unit {
  id           String   @id @default(cuid())
  // citext, like User.email and Item.serialNumber: an abbreviation is an
  // identity, and "WABC01" and "wabc01" are the same unit. Without this the
  // uppercase normalisation in learnUnits is convention-only, so any write site
  // that forgets it creates a second row that resolves differently.
  abbreviation String   @unique @db.Citext
  fullName     String
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
}
```

- [ ] **Step 4: Generate and inspect the migration**

```bash
npx prisma migrate diff --from-config-datasource prisma.config.ts --to-schema prisma/schema.prisma --script > migration.sql
```

Read the generated SQL. It should be an `ALTER TABLE "Unit" ALTER COLUMN "abbreviation" SET DATA TYPE CITEXT`. Move it into `prisma/migrations/<timestamp>_unit_abbreviation_citext/migration.sql` with a leading comment explaining why.

**Before applying, check for existing case-duplicates** — the conversion fails if two rows differ only by case:

```bash
npx prisma db execute --stdin <<< 'SELECT LOWER(abbreviation), COUNT(*) FROM "Unit" GROUP BY 1 HAVING COUNT(*) > 1;'
```

If any rows come back, stop and raise it: merging duplicate units is a data decision, not a migration.

- [ ] **Step 5: Apply and verify**

```bash
npx prisma migrate deploy
npx prisma generate
npx vitest run src/modules/items/units.service.test.ts
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/modules/items/units.service.test.ts
git commit -m "feat(units): make Unit.abbreviation citext so casing cannot fork a unit"
```

---

### Task 2: Batch `learnUnits`

`units.service.ts:21-31` is a `for` loop of `prisma.unit.upsert` — one round trip per row, the banned query-in-a-loop pattern. A bulk paste of fifty units would be fifty sequential round trips.

**Files:**
- Modify: `src/modules/items/units.service.ts:19-31`
- Test: `src/modules/items/units.service.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `learnUnits(resolutions: UnitResolution[], tx?: Prisma.TransactionClient): Promise<void>` — same name and behaviour, now batched and accepting an optional transaction client (mirroring `learnCategories`).

- [ ] **Step 1: Write the failing test**

Add to `src/modules/items/units.service.test.ts`:

```ts
describe("learnUnits", () => {
  beforeEach(async () => {
    await prisma.unit.deleteMany({ where: { abbreviation: { in: ["BATCH01", "BATCH02"] } } });
  });

  it("creates new units and updates existing names in one call", async () => {
    await prisma.unit.create({ data: { abbreviation: "BATCH01", fullName: "Old Name" } });

    await learnUnits([
      { abbreviation: "batch01", fullName: "New Name" },
      { abbreviation: "batch02", fullName: "Second Unit" },
    ]);

    const map = await loadUnitMap();
    expect(map.get("BATCH01")).toBe("New Name");
    expect(map.get("BATCH02")).toBe("Second Unit");
  });

  it("stores abbreviations uppercased regardless of input casing", async () => {
    await learnUnits([{ abbreviation: "batch02", fullName: "Second Unit" }]);
    const row = await prisma.unit.findUnique({ where: { abbreviation: "BATCH02" } });
    expect(row?.abbreviation).toBe("BATCH02");
  });

  it("is a no-op on an empty list", async () => {
    await expect(learnUnits([])).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/modules/items/units.service.test.ts`
Expected: the batching tests pass by accident under the old loop, EXCEPT you must confirm the query count changes. Instead assert behaviour now and verify the query shape in Step 4 by reading the code — the tests here lock in semantics so the rewrite cannot change them.

- [ ] **Step 3: Rewrite it**

Replace `learnUnits` in `src/modules/items/units.service.ts`:

```ts
/**
 * Register or re-teach unit abbreviations.
 *
 * THREE queries regardless of how many units are passed — never one per row.
 * A bulk paste from /admin/units can carry dozens, and the old implementation
 * was a `for` loop of upserts, i.e. one network round trip each (the same
 * pattern that made large imports time out; see the batching note in
 * items.service.ts).
 *
 * Abbreviations are stored uppercased. The column is citext so lookups already
 * ignore case, but normalising on write keeps the stored form consistent for
 * display.
 */
export async function learnUnits(
  resolutions: UnitResolution[],
  tx: Prisma.TransactionClient = prisma,
): Promise<void> {
  const parsed = z.array(resolutionSchema).parse(resolutions);
  if (parsed.length === 0) return;

  // Last write wins on a duplicate abbreviation within one batch.
  const wanted = new Map<string, string>();
  for (const r of parsed) wanted.set(r.abbreviation.toUpperCase(), r.fullName);

  const abbreviations = [...wanted.keys()];

  // 1. What already exists (citext, so this matches regardless of casing).
  const existing = await tx.unit.findMany({
    where: { abbreviation: { in: abbreviations } },
    select: { abbreviation: true, fullName: true },
  });
  const existingByAbbrev = new Map(existing.map((u) => [u.abbreviation.toUpperCase(), u.fullName]));

  // 2. Insert the ones that are new. skipDuplicates leans on the unique index
  //    as the race-safe backstop against a concurrent import adding the same
  //    abbreviation between the read above and this write.
  const toCreate = abbreviations
    .filter((a) => !existingByAbbrev.has(a))
    .map((a) => ({ abbreviation: a, fullName: wanted.get(a)! }));
  if (toCreate.length > 0) {
    await tx.unit.createMany({ data: toCreate, skipDuplicates: true });
  }

  // 3. Update only the ones whose name actually changed — one updateMany per
  //    distinct new name, which is bounded by the number of CHANGED units, not
  //    by the batch size. Writing no statement at all when nothing changed is
  //    what makes a no-op re-teach free.
  const changed = abbreviations.filter(
    (a) => existingByAbbrev.has(a) && existingByAbbrev.get(a) !== wanted.get(a),
  );
  const byNewName = new Map<string, string[]>();
  for (const a of changed) {
    const name = wanted.get(a)!;
    byNewName.set(name, [...(byNewName.get(name) ?? []), a]);
  }
  for (const [fullName, abbrevs] of byNewName) {
    await tx.unit.updateMany({ where: { abbreviation: { in: abbrevs } }, data: { fullName } });
  }
}
```

Add `import { Prisma } from "@prisma/client";` at the top if it is not already imported.

- [ ] **Step 4: Run the tests and the import suite**

```bash
npx vitest run src/modules/items/units.service.test.ts
npx vitest run src/modules/items
```
Expected: PASS. `commitImport` calls `learnUnits` before planning, so the import tests exercise this too.

- [ ] **Step 5: Commit**

```bash
git add src/modules/items/units.service.ts src/modules/items/units.service.test.ts
git commit -m "perf(units): batch learnUnits instead of one upsert per row"
```

---

### Task 3: Unit listing, rename-with-backfill, and delete

The service layer the page will sit on. `Item.homeUnit` holds the *full name*, denormalised with no FK, so a rename must rewrite the items too or the fleet ends up holding two spellings of one unit — which splits it into two entries in the `/items` filter and two bars in the analytics unit leaderboard.

**Files:**
- Modify: `src/modules/items/units.service.ts`
- Test: `src/modules/items/units.service.test.ts`

**Interfaces:**
- Consumes: `learnUnits` (Task 2), `diffItemFields` from `src/modules/items/item-diff.ts`.
- Produces:
  - `type UnitRow = { id: string; abbreviation: string; fullName: string; itemCount: number }`
  - `listUnitsWithCounts(): Promise<UnitRow[]>`
  - `countItemsWithHomeUnit(fullName: string): Promise<number>`
  - `renameUnit(id: string, fullName: string, editor: { id: string; name: string }): Promise<{ abbreviation: string; itemsUpdated: number }>`
  - `deleteUnit(id: string): Promise<{ abbreviation: string }>` — throws `ItemError("IN_USE")` while items carry the name.

**Note for the implementer:** `homeUnit` is ALREADY a member of `ItemLoggedFields` in `item-diff.ts` — no type change is needed. The importer simply never populates it. Build the `ItemEdit` rows with `field: "homeUnit"`.

- [ ] **Step 1: Write the failing tests**

Add to `src/modules/items/units.service.test.ts`:

```ts
describe("renameUnit", () => {
  it("rewrites every item carrying the old full name and logs each change", async () => {
    const unit = await prisma.unit.create({
      data: { abbreviation: "RENAME01", fullName: "Old Full Name" },
    });
    const admin = await prisma.user.findFirstOrThrow({ where: { role: "ADMIN" } });
    await prisma.item.createMany({
      data: [
        { make: "D", model: "1", serialNumber: "RN-1", homeUnit: "Old Full Name", createdById: admin.id },
        { make: "D", model: "1", serialNumber: "RN-2", homeUnit: "Old Full Name", createdById: admin.id },
        { make: "D", model: "1", serialNumber: "RN-3", homeUnit: "Untouched", createdById: admin.id },
      ],
    });

    const res = await renameUnit(unit.id, "New Full Name", { id: admin.id, name: admin.name });

    expect(res.itemsUpdated).toBe(2);
    expect((await prisma.item.findFirstOrThrow({ where: { serialNumber: "RN-1" } })).homeUnit).toBe("New Full Name");
    expect((await prisma.item.findFirstOrThrow({ where: { serialNumber: "RN-3" } })).homeUnit).toBe("Untouched");

    const item1 = await prisma.item.findFirstOrThrow({ where: { serialNumber: "RN-1" } });
    const edits = await prisma.itemEdit.findMany({ where: { itemId: item1.id } });
    expect(edits).toHaveLength(1);
    expect(edits[0].changes).toEqual([{ field: "homeUnit", from: "Old Full Name", to: "New Full Name" }]);
  });

  it("writes nothing when the name is unchanged", async () => {
    const unit = await prisma.unit.create({ data: { abbreviation: "RENAME02", fullName: "Same" } });
    const admin = await prisma.user.findFirstOrThrow({ where: { role: "ADMIN" } });
    const res = await renameUnit(unit.id, "Same", { id: admin.id, name: admin.name });
    expect(res.itemsUpdated).toBe(0);
  });
});

describe("deleteUnit", () => {
  it("refuses while items still carry the full name", async () => {
    const unit = await prisma.unit.create({ data: { abbreviation: "DEL01", fullName: "In Use Unit" } });
    const admin = await prisma.user.findFirstOrThrow({ where: { role: "ADMIN" } });
    await prisma.item.create({
      data: { make: "D", model: "1", serialNumber: "DEL-1", homeUnit: "In Use Unit", createdById: admin.id },
    });
    await expect(deleteUnit(unit.id)).rejects.toThrow(/still/i);
    expect(await prisma.unit.findUnique({ where: { id: unit.id } })).not.toBeNull();
  });

  it("deletes an unused unit", async () => {
    const unit = await prisma.unit.create({ data: { abbreviation: "DEL02", fullName: "Unused Unit" } });
    await deleteUnit(unit.id);
    expect(await prisma.unit.findUnique({ where: { id: unit.id } })).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/modules/items/units.service.test.ts`
Expected: FAIL — `renameUnit` / `deleteUnit` are not exported.

- [ ] **Step 3: Implement**

Add to `src/modules/items/units.service.ts`:

```ts
export type UnitRow = { id: string; abbreviation: string; fullName: string; itemCount: number };

/**
 * Every unit with the number of items whose homeUnit carries its full name.
 *
 * TWO queries regardless of unit count: the list, then ONE groupBy over items —
 * never a count per unit. Mirrors listCategoriesWithCounts.
 */
export async function listUnitsWithCounts(): Promise<UnitRow[]> {
  const [units, counts] = await Promise.all([
    prisma.unit.findMany({
      select: { id: true, abbreviation: true, fullName: true },
      orderBy: { fullName: "asc" },
    }),
    prisma.item.groupBy({
      by: ["homeUnit"],
      where: { homeUnit: { not: null } },
      _count: { _all: true },
    }),
  ]);

  const byName = new Map<string, number>();
  for (const c of counts) {
    if (!c.homeUnit) continue;
    const key = c.homeUnit.trim().toLowerCase();
    byName.set(key, (byName.get(key) ?? 0) + c._count._all);
  }

  return units.map((u) => ({
    ...u,
    itemCount: byName.get(u.fullName.trim().toLowerCase()) ?? 0,
  }));
}

/** How many items would a rename of this full name touch. Used to warn the
 *  admin BEFORE they commit a change that rewrites a thousand rows. */
export async function countItemsWithHomeUnit(fullName: string): Promise<number> {
  return prisma.item.count({ where: { homeUnit: fullName } });
}

/**
 * Correct a unit's full name, and rewrite every item carrying the old one.
 *
 * WHY THE BACKFILL: Unit has no FK to Item — `Item.homeUnit` is a denormalised
 * copy of `Unit.fullName`, written at import time. Renaming only the vocabulary
 * row would leave the fleet holding the old spelling, which shows up as TWO
 * entries in the /items unit filter and TWO bars in the analytics leaderboard
 * for one real unit.
 *
 * THREE queries in one transaction, never one per item: the update, one read of
 * the affected ids, and one createMany of history rows. `homeUnit` is already a
 * member of ItemLoggedFields, so these rows are shaped exactly like a hand edit.
 */
export async function renameUnit(
  id: string,
  rawFullName: string,
  editor: { id: string; name: string },
): Promise<{ abbreviation: string; itemsUpdated: number }> {
  const fullName = rawFullName.trim();
  if (!fullName) throw new ItemError("INVALID", "Enter a unit name.");

  const unit = await prisma.unit.findUnique({
    where: { id },
    select: { abbreviation: true, fullName: true },
  });
  if (!unit) throw new ItemError("NOT_FOUND", "That unit no longer exists.");
  if (unit.fullName === fullName) return { abbreviation: unit.abbreviation, itemsUpdated: 0 };

  return prisma.$transaction(async (tx) => {
    const affected = await tx.item.findMany({
      where: { homeUnit: unit.fullName },
      select: { id: true },
    });

    await tx.unit.update({ where: { id }, data: { fullName } });

    if (affected.length > 0) {
      await tx.item.updateMany({
        where: { id: { in: affected.map((a) => a.id) } },
        data: { homeUnit: fullName },
      });
      await tx.itemEdit.createMany({
        data: affected.map((a) => ({
          itemId: a.id,
          editedById: editor.id,
          editedByName: editor.name,
          changes: diffItemFields(
            { homeUnit: unit.fullName },
            { homeUnit: fullName },
          ) as unknown as Prisma.InputJsonValue,
        })),
      });
    }

    return { abbreviation: unit.abbreviation, itemsUpdated: affected.length };
  });
}

/**
 * Remove a unit from the vocabulary.
 *
 * REFUSED while items still carry its full name, mirroring deleteCategory.
 * With no FK, deleting an in-use unit leaves those devices holding a string
 * that appears in no picker, and stops the importer resolving the abbreviation.
 */
export async function deleteUnit(id: string): Promise<{ abbreviation: string }> {
  const unit = await prisma.unit.findUnique({
    where: { id },
    select: { abbreviation: true, fullName: true },
  });
  if (!unit) throw new ItemError("NOT_FOUND", "That unit no longer exists.");

  const inUse = await prisma.item.count({ where: { homeUnit: unit.fullName } });
  if (inUse > 0) {
    throw new ItemError(
      "IN_USE",
      `"${unit.fullName}" is still the home unit of ${inUse} item${inUse === 1 ? "" : "s"}. ` +
        "Reassign them first, then remove it.",
    );
  }

  await prisma.unit.delete({ where: { id } });
  return { abbreviation: unit.abbreviation };
}
```

Add imports at the top: `import { Prisma } from "@prisma/client";`, `import { ItemError } from "./items.errors";`, `import { diffItemFields } from "./item-diff";`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/modules/items/units.service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/items/units.service.ts src/modules/items/units.service.test.ts
git commit -m "feat(units): list with counts, rename with item backfill, and in-use-guarded delete"
```

---

### Task 4: Server Actions

**Files:**
- Create: `src/app/admin/actions/units.ts`
- Test: `src/app/admin/actions/units.test.ts`

**Interfaces:**
- Consumes: everything from Task 3, `requireAdmin` from `@/lib/authz`, `learnUnits` from Task 2.
- Produces:
  - `createUnitAction(prev, formData): Promise<{ ok: true } | { error: string }>`
  - `renameUnitAction(prev, formData): Promise<{ ok: true; itemsUpdated: number } | { error: string }>`
  - `deleteUnitAction(formData): Promise<{ ok: true } | { error: string }>`
  - `bulkLearnUnitsAction(prev, formData): Promise<{ ok: true; created: number; updated: number } | { error: string }>`

- [ ] **Step 1: Write the failing test**

Create `src/app/admin/actions/units.test.ts`. Follow the mocking pattern used by the existing admin action tests — read `src/app/actions/items.test.ts` first and mirror how it fakes `requireAdmin`.

```ts
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/authz", () => ({
  requireAdmin: vi.fn(async () => ({ id: "admin-1", role: "ADMIN", name: "Admin", email: "a@b.mil" })),
  AuthError: class extends Error {},
}));

describe("parseUnitBlock", () => {
  it("parses ABBREV,Full Name lines and ignores blanks", async () => {
    const { parseUnitBlock } = await import("./units");
    expect(parseUnitBlock("WABC01,HHC 1-8\n\n  WDEF02 , B CO 44  \n")).toEqual({
      units: [
        { abbreviation: "WABC01", fullName: "HHC 1-8" },
        { abbreviation: "WDEF02", fullName: "B CO 44" },
      ],
      errors: [],
    });
  });

  it("reports a line with no comma rather than silently dropping it", async () => {
    const { parseUnitBlock } = await import("./units");
    const res = parseUnitBlock("WABC01,HHC 1-8\nnonsense");
    expect(res.units).toHaveLength(1);
    expect(res.errors[0]).toMatch(/line 2/i);
  });

  it("reports an abbreviation with characters the schema forbids", async () => {
    const { parseUnitBlock } = await import("./units");
    const res = parseUnitBlock("W-ABC,Some Unit");
    expect(res.units).toHaveLength(0);
    expect(res.errors[0]).toMatch(/line 1/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/app/admin/actions/units.test.ts`
Expected: FAIL — cannot resolve `./units`.

- [ ] **Step 3: Implement**

Create `src/app/admin/actions/units.ts`:

```ts
"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/authz";
import { ItemError } from "@/modules/items/items.errors";
import {
  learnUnits,
  renameUnit,
  deleteUnit,
  resolutionSchema,
  type UnitResolution,
} from "@/modules/items/units.service";

/**
 * Parse a pasted block of `ABBREV,Full Name` lines.
 *
 * PURE and exported so it is unit-testable without a database. Reports bad
 * lines by number instead of dropping them: a silently ignored line in a paste
 * of fifty is exactly the kind of thing nobody notices until a unit is missing.
 */
export function parseUnitBlock(raw: string): { units: UnitResolution[]; errors: string[] } {
  const units: UnitResolution[] = [];
  const errors: string[] = [];

  raw.split(/\r?\n/).forEach((line, i) => {
    const text = line.trim();
    if (!text) return;
    const comma = text.indexOf(",");
    if (comma === -1) {
      errors.push(`Line ${i + 1}: expected "ABBREVIATION,Unit name".`);
      return;
    }
    const candidate = {
      abbreviation: text.slice(0, comma).trim(),
      fullName: text.slice(comma + 1).trim(),
    };
    const parsed = resolutionSchema.safeParse(candidate);
    if (!parsed.success) {
      errors.push(`Line ${i + 1}: ${parsed.error.issues[0]?.message ?? "invalid"}.`);
      return;
    }
    units.push(parsed.data);
  });

  return { units, errors };
}

const idSchema = z.string().min(1, "Missing unit.");

export async function createUnitAction(_prev: unknown, formData: FormData) {
  await requireAdmin();
  const parsed = resolutionSchema.safeParse({
    abbreviation: String(formData.get("abbreviation") ?? ""),
    fullName: String(formData.get("fullName") ?? ""),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  try {
    await learnUnits([parsed.data]);
  } catch (e) {
    console.error("[createUnitAction] failed:", e);
    return { error: "Something went wrong. Please try again." };
  }
  revalidatePath("/admin/units");
  return { ok: true as const };
}

export async function renameUnitAction(_prev: unknown, formData: FormData) {
  const admin = await requireAdmin();
  const id = idSchema.safeParse(String(formData.get("id") ?? ""));
  if (!id.success) return { error: "Missing unit." };
  const fullName = String(formData.get("fullName") ?? "").trim();
  if (!fullName) return { error: "Enter a unit name." };

  try {
    const res = await renameUnit(id.data, fullName, { id: admin.id, name: admin.name });
    revalidatePath("/admin/units");
    revalidatePath("/items");
    return { ok: true as const, itemsUpdated: res.itemsUpdated };
  } catch (e) {
    if (e instanceof ItemError) return { error: e.message };
    console.error("[renameUnitAction] failed:", e);
    return { error: "Something went wrong. Please try again." };
  }
}

export async function deleteUnitAction(formData: FormData) {
  await requireAdmin();
  const id = idSchema.safeParse(String(formData.get("id") ?? ""));
  if (!id.success) return { error: "Missing unit." };

  try {
    await deleteUnit(id.data);
  } catch (e) {
    if (e instanceof ItemError) return { error: e.message };
    console.error("[deleteUnitAction] failed:", e);
    return { error: "Something went wrong. Please try again." };
  }
  revalidatePath("/admin/units");
  return { ok: true as const };
}

export async function bulkLearnUnitsAction(_prev: unknown, formData: FormData) {
  await requireAdmin();
  const { units, errors } = parseUnitBlock(String(formData.get("block") ?? ""));
  if (errors.length > 0) return { error: errors.slice(0, 5).join(" ") };
  if (units.length === 0) return { error: "Nothing to add." };

  try {
    await learnUnits(units);
  } catch (e) {
    console.error("[bulkLearnUnitsAction] failed:", e);
    return { error: "Something went wrong. Please try again." };
  }
  revalidatePath("/admin/units");
  return { ok: true as const, created: units.length, updated: 0 };
}
```

**Note:** `bulkLearnUnitsAction` reports how many lines were submitted, not a created/updated split — `learnUnits` does not return one. If the UI needs the split, extend `learnUnits` to return `{ created, updated }` and thread it through; do not compute it with a second query.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/app/admin/actions/units.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/app/admin/actions/units.ts src/app/admin/actions/units.test.ts
git commit -m "feat(units): admin server actions for create, rename, delete and bulk teach"
```

---

### Task 5: The `/admin/units` page

**Files:**
- Create: `src/app/admin/units/page.tsx`
- Create: `src/app/admin/units/UnitManager.tsx`
- Modify: `src/app/admin/page.tsx` (add the nav link)

**Interfaces:**
- Consumes: `listUnitsWithCounts` (Task 3), the actions from Task 4.
- Produces: the route `/admin/units`.

- [ ] **Step 1: Read the pattern to copy**

Read `src/app/admin/categories/page.tsx` and `src/app/admin/categories/CategoryManager.tsx` in full. This page is the same shape: a Server Component that gates on `requireAdmin()` and passes rows to a Client Component holding the forms. Match its markup and class names — do not invent a new layout.

- [ ] **Step 2: Write the page**

Create `src/app/admin/units/page.tsx`:

```tsx
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAdmin, AuthError } from "@/lib/authz";
import { listUnitsWithCounts } from "@/modules/items/units.service";
import { UnitManager } from "./UnitManager";

export const metadata = { title: "Units" };

/** ADMIN-only: the unit vocabulary is what the importer resolves device names
 *  against, so curating it is a privileged capability. The admin layout already
 *  gates this subtree, but the page re-checks so the guard travels with the
 *  route rather than depending on its parent. */
export default async function UnitsPage() {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) redirect(e.code === "FORBIDDEN" ? "/" : "/login");
    throw e;
  }

  const units = await listUnitsWithCounts();

  return (
    <div className="stack">
      <div className="row">
        <div>
          <h1 className="page-title">Units</h1>
          <p className="subtle">
            Abbreviations the importer resolves device names against. Correcting a
            unit&apos;s name also updates every item currently assigned to it.
          </p>
        </div>
        <Link href="/admin" className="btn btn-secondary spacer">Back to admin</Link>
      </div>
      <UnitManager units={units} />
    </div>
  );
}
```

- [ ] **Step 3: Write the client component**

Create `src/app/admin/units/UnitManager.tsx` as a `"use client"` component taking `{ units: UnitRow[] }`. Mirror `CategoryManager.tsx`'s structure and `useActionState` usage. It needs:

1. **A table** of abbreviation, full name, item count, and per-row Rename / Remove controls. Use `.table`.
2. **An add form** — two inputs (abbreviation, full name) and a submit, wired to `createUnitAction`.
3. **A bulk paste panel** — a `<textarea name="block">` with placeholder `WABC01,HHC 1-8`, wired to `bulkLearnUnitsAction`, and help text saying one unit per line as `ABBREVIATION,Unit name`.
4. **Rename confirmation.** Before submitting a rename, show the row's `itemCount` in the confirm copy: `Renaming this unit will also update N items currently assigned to it.` The count is already on the row — do not fetch it again.
5. **Error and success messages** rendered from each action's returned state, never thrown.

Every interactive control keeps the 44px touch-target floor already provided by `.btn` in `globals.css`.

- [ ] **Step 4: Link it from the admin dashboard**

In `src/app/admin/page.tsx`, add a link to `/admin/units` next to the existing Device categories link, matching its markup exactly.

- [ ] **Step 5: Verify it builds and renders**

```bash
npm run lint
npm run build
```

Then start the dev server and open `/admin/units` signed in as an admin. Confirm by hand:
- the table lists units with counts,
- adding a unit works and it appears,
- renaming a unit with items warns with the count and, after saving, the items' Home unit on `/items` shows the new name,
- removing an in-use unit is refused with the message naming the count,
- removing an unused unit works.

**`npm run build` and jsdom are not evidence for the visual result** — neither has a layout engine. Check it in a browser.

- [ ] **Step 6: Commit**

```bash
git add src/app/admin/units src/app/admin/page.tsx
git commit -m "feat(units): /admin/units page for bulk unit management"
```

---

### Task 6: Surface what the last import could not resolve

Closes the loop the automated import opens: with no human at the resolution step, unresolved abbreviations must be visible somewhere.

**Files:**
- Modify: `src/modules/items/units.service.ts`
- Modify: `src/app/admin/units/page.tsx`
- Modify: `src/app/admin/units/UnitManager.tsx`
- Test: `src/modules/items/units.service.test.ts`

**Interfaces:**
- Consumes: `listUnitsWithCounts` (Task 3).
- Produces: `listUnassignedHomeUnits(limit?: number): Promise<{ deviceName: string; id: string }[]>` and `lastImportAt(): Promise<Date | null>`.

- [ ] **Step 1: Write the failing test**

```ts
describe("listUnassignedHomeUnits", () => {
  it("returns active items with a device name but no home unit", async () => {
    const admin = await prisma.user.findFirstOrThrow({ where: { role: "ADMIN" } });
    await prisma.item.create({
      data: { make: "D", model: "1", serialNumber: "NOUNIT-1", deviceName: "ZZTOP99-LT-1", createdById: admin.id },
    });
    const rows = await listUnassignedHomeUnits();
    expect(rows.some((r) => r.deviceName === "ZZTOP99-LT-1")).toBe(true);
  });
});

describe("lastImportAt", () => {
  it("returns null when nothing has ever been imported", async () => {
    await prisma.importBatch.deleteMany({});
    expect(await lastImportAt()).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/modules/items/units.service.test.ts`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement**

```ts
/**
 * Items the importer could not derive a home unit for.
 *
 * BOUNDED — never an unbounded findMany over a growing table. The page shows a
 * sample so an admin can spot the pattern (usually one new abbreviation across
 * many devices) and teach it; it is not meant to be a worklist of every row.
 */
export async function listUnassignedHomeUnits(
  limit = 50,
): Promise<{ id: string; deviceName: string }[]> {
  const rows = await prisma.item.findMany({
    where: { homeUnit: null, deviceName: { not: null }, status: "ACTIVE" },
    select: { id: true, deviceName: true },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.map((r) => ({ id: r.id, deviceName: r.deviceName! }));
}

/**
 * When the fleet was last refreshed by an import.
 *
 * WHY IT IS SHOWN: the automated import runs with nobody watching, and a dead
 * scheduled job looks exactly like a fleet that stopped changing. A visible
 * timestamp is the cheapest way for that failure to be noticed in days rather
 * than weeks.
 */
export async function lastImportAt(): Promise<Date | null> {
  const batch = await prisma.importBatch.findFirst({
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  return batch?.createdAt ?? null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/modules/items/units.service.test.ts`
Expected: PASS.

- [ ] **Step 5: Show them on the page**

In `page.tsx`, fetch all three in one `Promise.all` and pass them down:

```tsx
const [units, unassigned, lastImport] = await Promise.all([
  listUnitsWithCounts(),
  listUnassignedHomeUnits(),
  lastImportAt(),
]);
```

In `UnitManager.tsx` add:
- A line near the top: `Fleet last imported <relative time>` — or, when `lastImport` is null, `No import has run yet.` If it is more than 48 hours old, mark it visually (the existing `.warn`/`.subtle` classes in `globals.css` — check which exists) with `The scheduled import may not be running.`
- A collapsible panel listing the unassigned device names with a count, headed `Devices with no home unit`, and copy explaining that adding the matching abbreviation above will let the next import resolve them.

- [ ] **Step 6: Verify in a browser and commit**

```bash
npm run lint && npm run build
npx vitest run src/modules/items
```

Check `/admin/units` in a real browser, then:

```bash
git add src/modules/items/units.service.ts src/app/admin/units
git commit -m "feat(units): surface unresolved home units and the last import time"
```

---

### Task 7: Documentation

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Changelog**

Add under `## 2026-07-29` (merge with an existing section for that date):

```markdown
### Added
- **A Units page for admins** at `/admin/units`. Add units one at a time or paste a whole block of `ABBREVIATION,Unit name` lines. Correcting a unit's name also updates every item currently assigned to it, and the page tells you how many that is before you save. Removing a unit is refused while items still use it.
- **The Units page shows devices with no home unit** and when the fleet was last imported, so an unrecognised abbreviation — or an import that quietly stopped running — is visible instead of silent.

### Changed
- **Unit abbreviations are now case-insensitive.** `WABC01` and `wabc01` are one unit rather than two.
```

- [ ] **Step 2: CLAUDE.md**

Add to the readiness/analytics feature-constraints section, next to the categories bullet:

```markdown
* **Units are a MANAGED LIST with a DENORMALIZED value, exactly like categories — and the same two rules keep them coherent.** `Unit` (citext-unique `abbreviation` → `fullName`) is the vocabulary admins maintain at `/admin/units`; `Item.homeUnit` stores the resolved **full name** as plain text with no FK, written by the importer via `detectHomeUnit`. So: **deletion is refused while any item carries the full name**, and **renaming a unit backfills every item holding the old one** (`renameUnit`, one `updateMany` plus batched `ItemEdit` rows — `homeUnit` is already in `ItemLoggedFields`). Skipping the backfill leaves the fleet holding two spellings of one unit, which splits it into two entries in the `/items` filter and two bars in the analytics leaderboard. `learnUnits` is batched (3 queries) and must stay that way — it was a per-row upsert loop.
```

- [ ] **Step 3: Verify and commit**

```bash
npm run check:security-docs
git add CHANGELOG.md CLAUDE.md
git commit -m "docs: bulk unit management"
```

---

## Self-Review

**Spec coverage:** citext → Task 1. `learnUnits` batching → Task 2. List/rename/backfill/delete → Task 3. Actions → Task 4. Page → Task 5. Unresolved surfacing + staleness signal → Task 6. Docs → Task 7.

**Correction to the spec:** the spec says the backfill "requires adding `homeUnit` to the `ItemEdit` logged-field set". That is wrong — `homeUnit` is already a member of `ItemLoggedFields` (`item-diff.ts:14`); the importer simply never populates it. No type change is needed. Fix that line in the spec when this lands.

**Dependency on the import plan:** none at the code level. This plan ships and is useful on its own — an admin gets bulk unit management whether or not the automated import exists. Task 6's staleness signal reads `ImportBatch`, which is already written by the existing browser import.

**Deliberately not included:** merging two units into one (a data decision, and Task 1 Step 4 stops the migration if case-duplicates already exist), and any change to how `detectHomeUnit` matches device-name segments.
