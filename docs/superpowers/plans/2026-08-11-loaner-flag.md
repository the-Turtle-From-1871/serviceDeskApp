# Loaner flag — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator mark a scanned or selected batch of devices as loaner-pool stock, see the mark on the item and in the `/items` table, and filter the list down to the pool — with a flag the nightly CSV import can never revert.

**Architecture:** One new `Item.isLoaner` boolean, written only by a batched `updateMany` behind a `MANAGE_ITEMS` Server Action, surfaced through the existing "More actions" popover, a new hideable column, a badge, and a one-way `MenuToggle` filter that must be added to **both** of `listItems`' query paths.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 5, Prisma 7 on PostgreSQL, Zod, Vitest (node + jsdom).

**Spec:** `docs/superpowers/specs/2026-08-11-loaner-flag-design.md`

## Global Constraints

Every task's requirements implicitly include all of these.

- **Never query inside a loop.** One `updateMany` / `findMany`, never `Promise.all(ids.map(...))`.
- **Service functions enforce NO permissions.** The calling Server Action owns the guard, and every action starts with `requireCapability()` from `@/lib/authz` — never bare `auth()`.
- **Cap every bulk write at `MAX_BULK_ITEMS` (500)**, imported from `@/modules/items/items.schema` (the PURE module — `items.service.ts` imports Prisma and must never reach a client bundle).
- **Retired items are excluded and reported, never refused.** The bulk function returns `{ updated, skipped }`.
- **Return shapes are ANNOTATED, not inferred** — a `"use server"` module may only export async functions, so result unions stay local `type` declarations in the action file.
- **Errors:** generic message to the client, `console.error` with the real error server-side.
- **`isLoaner` must never enter the CSV import's column mapping.** That is the whole point of the field; a test pins it.
- **Do NOT add `isLoaner` to `editableItemFields`.** An unchecked checkbox sends nothing in `FormData` and `z.object()` strips unknown keys, so unticking would report "Saved" and change nothing. The spec rejects it explicitly.
- **Tests sit beside their subject.** jsdom is opt-in per file via `// @vitest-environment jsdom` on **line 1**; never add a second docblock to a file that has one.
- **`npm run build` and jsdom are NOT evidence for a CSS change.** Neither has a layout engine.
- **Docs ship in the same commit as the code.**
- **Do not run `npm test` (the whole suite) or `npm run build` without checking first** — another session may share this repo's test database and generated Prisma client. Run the named subsets each task specifies.
- **Line numbers in this plan refer to `origin/main` at `81a5f46`.** Re-locate by the quoted code if an earlier task has shifted them.

---

## File Structure

**Create:**
- `prisma/migrations/20260811210000_item_is_loaner/migration.sql` — the additive column + index.
- `src/modules/items/items.loaner.test.ts` — DB tests for `setItemsLoaner`, including the import-does-not-revert property.

**Modify:**
- `prisma/schema.prisma` — the column and its index.
- `src/modules/items/items.service.ts` — `setItemsLoaner`; the `loaner` filter in `listItems`, `itemFilterSql`, `derivedOrderedItemIds` and `ItemsPage`.
- `src/app/admin/actions/items.ts` — `setItemsLoanerAction`.
- `src/app/admin/actions/items.test.ts` — its capability-refusal tests.
- `src/modules/items/items.readiness-sort.parity.test.ts` — parity coverage for the new filter.
- `src/components/items-view.ts` — `ItemRow.isLoaner`, the `loaner` column key, `UNSORTABLE_COLUMNS`.
- `src/components/items-view.test.ts` — the sortable/unsortable assertions that enumerate keys.
- `src/components/BulkActionsMenu.tsx` — `canRename` → `canManageItems`, plus the loaner pair.
- `src/components/BulkActionsMenu.test.tsx` — the renamed prop and the new controls.
- `src/components/ItemSelectTable.tsx` — the prop rename at the mount site, the column cell, the card badge.
- `src/components/ItemSelectTable.test.tsx` — column/badge coverage.
- `src/app/items/page.tsx` — read `?loaner`, pass `isLoaner` down.
- `src/app/items/ItemsSearchInput.tsx` — carry `loaner` through the URL rebuild.
- `src/app/i/[itemId]/page.tsx` — the badge beside `StatusBadge`.
- `src/app/globals.css` — `.badge-loaner`.
- `CHANGELOG.md`, `docs/SECURITY.md`, `.claude/rules/backend-constraints.md`, `CLAUDE.md`.

---

### Task 1: The column, the migration, and the batched write

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260811210000_item_is_loaner/migration.sql`
- Modify: `src/modules/items/items.service.ts`
- Create: `src/modules/items/items.loaner.test.ts`

**Interfaces:**
- Consumes: `MAX_BULK_ITEMS` from `./items.schema`; `ItemError` from `./items.errors`; `prisma` from `@/lib/prisma`.
- Produces: `setItemsLoaner(itemIds: string[], isLoaner: boolean): Promise<{ updated: number; skipped: number }>`.

- [ ] **Step 1: Add the column to the schema**

In `prisma/schema.prisma`, inside `model Item`, add the field immediately after `storageLocation` (currently line 222):

```prisma
  /// Pool stock: a device kept to lend out temporarily, over and over.
  ///
  /// STORED rather than derived, unlike readiness and accountability — and the
  /// distinction is the reason this column is allowed to exist. Those two were
  /// dropped because they stored answers the data already knew. NOTHING here can
  /// infer loaner-ness: no signal separates a laptop kept for lending from an
  /// identical one issued permanently. It is a standing decision by the property
  /// manager, so a person is the only possible source.
  ///
  /// DELIBERATELY NOT IMPORTABLE. The CSV importer writes a named column set
  /// (see import.ts), and this is not in it — which is the entire reason it is a
  /// new column rather than a reused deviceCategory/homeUnit/storageLocation.
  /// Any of those would be reverted by the nightly Drive import within a day.
  isLoaner                   Boolean           @default(false)
```

And add the index beside the other low-cardinality filter indexes (near `@@index([deviceCategory])`, currently line 309):

```prisma
  // Low-cardinality equality filter feeding a paginated list, same as
  // deviceCategory/deviceUIC above.
  @@index([isLoaner])
```

- [ ] **Step 2: Author the migration by hand**

`prisma migrate dev` cannot run non-interactively in this environment. Migrations here are hand-authored SQL with a rationale header — `prisma/migrations/20260811150000_item_last_sync_at/migration.sql` is the reference.

Create `prisma/migrations/20260811210000_item_is_loaner/migration.sql`:

```sql
-- Pool stock: a device kept to lend out temporarily, over and over.
--
-- A new column rather than a reused one, deliberately. deviceCategory, homeUnit
-- and storageLocation are all IMPORTABLE, so the nightly Drive import would
-- revert the mark within a day — "a control that quietly undoes itself is worse
-- than no control". The importer writes a named column set and this is not in
-- it, so it survives every import.
--
-- NOT NULL with a default and no backfill: every existing device is not a
-- loaner, which is a complete and correct answer. A nullable third state would
-- mean "nobody has said", which nothing in this feature reads.
--
-- Additive, so it is safe to apply BEFORE the code that reads it deploys — and
-- it must be, per migrate-before-push: Prisma enumerates every column in its
-- SELECT, so until this exists every item read fails, not just the new control.

-- AlterTable
ALTER TABLE "Item" ADD COLUMN     "isLoaner" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Item_isLoaner_idx" ON "Item"("isLoaner");
```

- [ ] **Step 3: Apply it and regenerate the client**

Run: `npx prisma migrate deploy`
Expected: the migration applies cleanly.

Run: `npx prisma generate`
Expected: success.

**If another session is using this repo, the generated client is SHARED** — regenerating can pull the schema out from under a running dev server elsewhere. Confirm nothing else is running before this step; if something is, stop and report rather than regenerating.

- [ ] **Step 4: Write the failing DB test**

Create `src/modules/items/items.loaner.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import prisma from "@/lib/prisma";
import { setItemsLoaner } from "./items.service";

async function mkItem(serial: string, status: "ACTIVE" | "RETIRED" = "ACTIVE") {
  return prisma.item.create({
    data: { make: "Dell", model: "5540", serialNumber: serial, deviceName: `dev-${serial}`, status },
  });
}

describe("setItemsLoaner", () => {
  it("marks a batch and clears it again", async () => {
    const items = await Promise.all([mkItem("LOAN1"), mkItem("LOAN2")]);
    const ids = items.map((i) => i.id);

    expect(await setItemsLoaner(ids, true)).toEqual({ updated: 2, skipped: 0 });
    let rows = await prisma.item.findMany({ where: { id: { in: ids } } });
    expect(rows.every((r) => r.isLoaner)).toBe(true);

    expect(await setItemsLoaner(ids, false)).toEqual({ updated: 2, skipped: 0 });
    rows = await prisma.item.findMany({ where: { id: { in: ids } } });
    expect(rows.every((r) => !r.isLoaner)).toBe(true);
  });

  // A device that has left the fleet cannot be pool stock, and one retired row
  // must not fail a batch of fifty.
  it("excludes retired items and reports them as skipped", async () => {
    const active = await mkItem("LOAN3");
    const retired = await mkItem("LOAN4", "RETIRED");

    expect(await setItemsLoaner([active.id, retired.id], true)).toEqual({ updated: 1, skipped: 1 });

    const fresh = await prisma.item.findUniqueOrThrow({ where: { id: retired.id } });
    expect(fresh.isLoaner).toBe(false);
  });

  it("is idempotent", async () => {
    const item = await mkItem("LOAN5");
    await setItemsLoaner([item.id], true);
    expect(await setItemsLoaner([item.id], true)).toEqual({ updated: 1, skipped: 0 });
    const fresh = await prisma.item.findUniqueOrThrow({ where: { id: item.id } });
    expect(fresh.isLoaner).toBe(true);
  });

  it("is a no-op for an empty list", async () => {
    expect(await setItemsLoaner([], true)).toEqual({ updated: 0, skipped: 0 });
  });

  it("throws TOO_MANY above the cap", async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `id-${i}`);
    await expect(setItemsLoaner(ids, true)).rejects.toMatchObject({ code: "TOO_MANY" });
  });
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `npx vitest run items.loaner`
Expected: FAIL — `setItemsLoaner is not a function`.

- [ ] **Step 6: Implement `setItemsLoaner`**

Add to `src/modules/items/items.service.ts`, immediately after `markItemsReady` (currently ending line 672):

```ts
/**
 * Mark items as loaner-pool stock, or take them back out of the pool.
 *
 * One updateMany, never a loop — the batched twin of every other bulk control
 * on the /items selection bar.
 *
 * RETIRED items are excluded and REPORTED, not refused: a device that has left
 * the fleet cannot be pool stock, and one retired row must not fail a batch of
 * fifty. That is the cross-cutting rule for bulk actions here and it diverges
 * from the single-item paths on purpose.
 *
 * `skipped` is "rows this action did not write", which includes rows that no
 * longer exist as well as retired ones. It deliberately does NOT filter on
 * `isLoaner: !isLoaner` — that would make the count exact but would reclassify
 * "already a loaner" as skipped, which the sheet reports as "retired or not
 * applicable" and would read as a failure.
 *
 * Enforces NO permissions — the calling Server Action owns the capability gate.
 */
export async function setItemsLoaner(
  itemIds: string[],
  isLoaner: boolean,
): Promise<{ updated: number; skipped: number }> {
  const ids = [...new Set(itemIds.filter((id) => id.trim() !== ""))];
  if (ids.length === 0) return { updated: 0, skipped: 0 };
  if (ids.length > MAX_BULK_ITEMS) throw new ItemError("TOO_MANY");

  const res = await prisma.item.updateMany({
    where: { id: { in: ids }, status: "ACTIVE" },
    data: { isLoaner },
  });
  return { updated: res.count, skipped: ids.length - res.count };
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run items.loaner`
Expected: PASS, 5 tests.

- [ ] **Step 8: Pin that an import cannot revert the mark**

This is the load-bearing property of the whole design. Append to `src/modules/items/items.loaner.test.ts`:

```ts
import { commitImport } from "./items.service";

// THE property this column exists for. deviceCategory, homeUnit and
// storageLocation are all importable, so a loaner mark stored in any of them
// would be reverted by the nightly Drive import within a day. commitImport
// writes a NAMED column set built from the CSV row, and isLoaner is not in it.
// A future refactor that widened that set would break this silently.
it("survives a CSV import that updates the same device", async () => {
  const item = await mkItem("LOAN6");
  await setItemsLoaner([item.id], true);

  const csv = ["serialNumber,deviceName", "LOAN6,renamed-by-import"].join("\n");
  await commitImport(csv, item.createdById ?? undefined);

  const fresh = await prisma.item.findUniqueOrThrow({ where: { id: item.id } });
  expect(fresh.deviceName).toBe("renamed-by-import");
  expect(fresh.isLoaner).toBe(true);
});
```

**`commitImport`'s exact signature and its `createdById` requirement are not restated here** — read them from `items.service.ts` and from the existing `src/modules/items/items.service.import.test.ts`, and follow how that file builds a CSV and supplies the importing user. If the item factory above does not give you a usable `createdById`, create a user the way that test file does. The assertion is what matters: `deviceName` changed, `isLoaner` did not.

- [ ] **Step 9: Run it**

Run: `npx vitest run items.loaner`
Expected: PASS, 6 tests. If the import test fails because the import *did* clear the flag, stop and report — that means the column set is not what the design assumed and the whole approach needs revisiting.

- [ ] **Step 10: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260811210000_item_is_loaner/migration.sql \
        src/modules/items/items.service.ts src/modules/items/items.loaner.test.ts
git commit -m "feat(items): add Item.isLoaner and a batched setter"
```

---

### Task 2: The capability-gated action

**Files:**
- Modify: `src/app/admin/actions/items.ts`
- Modify: `src/app/admin/actions/items.test.ts`
- Modify: `docs/SECURITY.md`

**Interfaces:**
- Consumes: `setItemsLoaner` from `@/modules/items/items.service`; `requireCapability` from `@/lib/authz`; `MAX_BULK_ITEMS`; `ItemError`.
- Produces: `setItemsLoanerAction(formData: FormData): Promise<LoanerResult>` where `LoanerResult = { error: string } | { ok: true; updated: number; skipped: number; isLoaner: boolean }`.

- [ ] **Step 1: Write the failing action test**

Append to `src/app/admin/actions/items.test.ts`, following that file's existing session-mocking helper — read how the rename-action tests added in `81a5f46` mock the session and copy that shape exactly rather than inventing one:

```ts
describe("setItemsLoanerAction", () => {
  it("refuses a caller without MANAGE_ITEMS", async () => {
    const f = new FormData();
    f.set("itemIds", "a1,a2");
    f.set("isLoaner", "1");
    await expect(setItemsLoanerAction(f)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses an empty selection", async () => {
    const f = new FormData();
    f.set("itemIds", "");
    f.set("isLoaner", "1");
    const res = await setItemsLoanerAction(f);
    expect(res).toEqual({ error: "Select at least one item." });
  });
});
```

Add `setItemsLoanerAction` to the file's existing import from `./items`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run admin/actions/items`
Expected: FAIL — `setItemsLoanerAction` is not exported.

- [ ] **Step 3: Implement the action**

Add to `src/app/admin/actions/items.ts`, beside `markItemsReadyAction`. Add `setItemsLoaner` to the existing import from `@/modules/items/items.service`:

```ts
const setLoanerSchema = z.object({
  itemIds: z.array(z.string().min(1)).min(1, "Select at least one item."),
  isLoaner: z.boolean(),
});

/* Annotated, not inferred: a "use server" module may only export async
   functions, so the union stays a local type — which is what lets the client
   narrow with `"error" in res` and get a number rather than number | undefined. */
type LoanerResult =
  | { error: string }
  | { ok: true; updated: number; skipped: number; isLoaner: boolean };

/**
 * Mark the selected items as loaner-pool stock, or take them out of it.
 *
 * MANAGE_ITEMS, not ADMINISTER: this is item vocabulary, the same capability
 * the rename and category controls use. The batch is client-supplied ids, so
 * this guard is the entire boundary — the sheet hiding the buttons is
 * presentation, not security.
 *
 * Revalidates /items only. Not /admin/analytics: nothing on the dashboard reads
 * this flag yet, and that entry must be added when the loaner bucket ships.
 * Not the 500 individual /i/<id> paths either — setReadinessAction sets that
 * precedent, and the item page picks the badge up on its next render.
 */
export async function setItemsLoanerAction(formData: FormData): Promise<LoanerResult> {
  await requireCapability("MANAGE_ITEMS");

  const parsed = setLoanerSchema.safeParse({
    itemIds: String(formData.get("itemIds") ?? "").split(",").filter(Boolean),
    // Exactly "1" is on. Anything else is off, so a malformed value cannot
    // accidentally mark a batch.
    isLoaner: String(formData.get("isLoaner") ?? "") === "1",
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  try {
    const { updated, skipped } = await setItemsLoaner(parsed.data.itemIds, parsed.data.isLoaner);
    revalidatePath("/items");
    return { ok: true, updated, skipped, isLoaner: parsed.data.isLoaner };
  } catch (e) {
    if (e instanceof ItemError && e.code === "TOO_MANY") {
      return { error: `Too many items selected. The limit is ${MAX_BULK_ITEMS} per action.` };
    }
    console.error("[setItemsLoanerAction] unexpected error:", e);
    return { error: "Something went wrong updating those items. Please try again." };
  }
}
```

- [ ] **Step 4: Run the action tests**

Run: `npx vitest run admin/actions/items`
Expected: PASS.

- [ ] **Step 5: Update `docs/SECURITY.md`**

Add `setItemsLoanerAction` to the authz-controls inventory beside the two rename actions that `81a5f46` added — match their entry format. State: gated on `MANAGE_ITEMS`; item ids are client-supplied and bounded at `MAX_BULK_ITEMS` (500); retired items are excluded server-side; the only value it can write is one boolean, so the control cannot be turned into an arbitrary write. Bump the *Last reviewed* date at the top.

- [ ] **Step 6: Commit**

```bash
git add src/app/admin/actions/items.ts src/app/admin/actions/items.test.ts docs/SECURITY.md
git commit -m "feat(items): gate the loaner mark behind MANAGE_ITEMS"
```

---

### Task 3: The `?loaner=1` filter, in both query paths

`listItems` runs a Prisma `where` normally and a raw-SQL twin whenever the sort involves a derived key. A filter added to one and not the other makes the page's contents depend on which column is sorted — which is exactly what `items.readiness-sort.parity.test.ts` exists to catch.

**Files:**
- Modify: `src/modules/items/items.service.ts`
- Modify: `src/modules/items/items.readiness-sort.parity.test.ts`
- Modify: `src/app/items/page.tsx`
- Modify: `src/app/items/ItemsSearchInput.tsx`

**Interfaces:**
- Consumes: `firstParam` from `@/lib/search-params`.
- Produces: `listItems({ ..., loaner?: boolean })`, and `ItemsPage.loaner: boolean` echoed back.

- [ ] **Step 1: Add the option and the Prisma filter**

In `src/modules/items/items.service.ts`:

Add to the `ItemsPage` type, beside `needsRename`:

```ts
  /** Echoed back so the page can rebuild its own URL without re-reading the
   *  querystring — the same reason `uic` and `needsRename` are here. */
  loaner: boolean;
```

Add to `listItems`' options, after `needsRename`:

```ts
  /** Show only loaner-pool stock. A ONE-WAY worklist filter, like needsRename:
   *  false means "no filter", never "only devices that are not loaners". */
  loaner?: boolean;
```

In the body, beside `const needsRename = ...`:

```ts
  const loaner = opts.loaner === true;
```

and beside the `needsRename` filter push:

```ts
  // The Prisma twin of the clause in itemFilterSql. Both paths must carry every
  // filter or items.readiness-sort.parity.test.ts fails.
  if (loaner) filters.push({ isLoaner: true });
```

Pass `loaner` into the `derivedOrderedItemIds({ ... })` call alongside `needsRename`, and add `loaner` to the returned object at the end of `listItems`.

- [ ] **Step 2: Add the SQL twin**

Change `itemFilterSql`'s signature and body:

```ts
function itemFilterSql(
  search: string | null,
  uic: string | null,
  needsRename: boolean,
  loaner: boolean,
): Prisma.Sql {
```

and append this line to the returned `Prisma.sql` template, after the `needsRename` clause:

```
    AND (${loaner}::boolean IS NOT TRUE OR i."isLoaner" IS TRUE)
```

Add `loaner: boolean` to `derivedOrderedItemIds`' options type and thread it into its `itemFilterSql(...)` call.

- [ ] **Step 3: Extend the parity test**

`src/modules/items/items.readiness-sort.parity.test.ts` compares the two paths. Read how it currently exercises `uic`/`needsRename` and add the same shape for `loaner`: seed a marked and an unmarked ACTIVE item, then assert that `listItems({ loaner: true })` returns the same ids on the **Prisma** path (a plain column sort, e.g. `sort: "serialNumber"`) and on the **raw** path (a derived sort, e.g. `sort: "readiness"`), and that both exclude the unmarked row.

- [ ] **Step 4: Run the query tests**

Run: `npx vitest run items.readiness-sort.parity items.service`
Expected: PASS.

- [ ] **Step 5: Read the param on the page**

In `src/app/items/page.tsx`, add `loaner?: string | string[]` to the `searchParams` type, and pass it into `listItems`:

```ts
      // Exactly "1" is on, matching needsRename. A permissive check would make
      // `?loaner=0` mean the opposite of what it says.
      loaner: firstParam(sp.loaner) === "1",
```

Pass `loaner={result.loaner}` to both `<ItemsSearchInput>` and `<ItemSelectTable>`.

- [ ] **Step 6: Carry it through the URL rebuild**

`src/app/items/ItemsSearchInput.tsx` rebuilds the whole `/items` URL from scratch on every keystroke, and its own comment records that this is how the UIC filter and the secondary sort key were both silently lost. Add `loaner` to the props, add a `loanerRef` beside `needsRenameRef`, sync it in the same effect, and add to the param builder beside the `needsRename` line:

```ts
      if (loanerRef.current) params.set("loaner", "1");
```

- [ ] **Step 7: Run the search-input tests**

Run: `npm run test:ui`
Expected: PASS, including `ItemsSearchInput.test.tsx`.

- [ ] **Step 8: Commit**

```bash
git add src/modules/items/items.service.ts src/modules/items/items.readiness-sort.parity.test.ts \
        src/app/items/page.tsx src/app/items/ItemsSearchInput.tsx
git commit -m "feat(items): filter the property book down to loaner stock"
```

---

### Task 4: The controls in the "More actions" sheet

**Files:**
- Modify: `src/components/BulkActionsMenu.tsx`
- Modify: `src/components/BulkActionsMenu.test.tsx`
- Modify: `src/components/ItemSelectTable.tsx`

**Interfaces:**
- Consumes: `setItemsLoanerAction` from `@/app/admin/actions/items`; the component's existing `run(...)` helper and `Msg` type.
- Produces: `BulkActionsMenu` prop `canManageItems: boolean` **replacing** `canRename`.

- [ ] **Step 1: Rename the MANAGE_ITEMS prop**

`canRename` gated one control; it now gates two, and a loaner button hidden by a flag called "rename" would puzzle the next reader. In `src/components/BulkActionsMenu.tsx` rename the prop `canRename` → `canManageItems` — in the destructured params, the props type (keep a doc comment saying `MANAGE_ITEMS — the bulk rename and the loaner mark`), the docblock's `canAudit`/`canQueue`/`canRename` sentence, the `if (!canAudit && !canQueue && !canRename) return null` guard, and the rename group's own `{canRename && (` gate.

Update the single mount site in `src/components/ItemSelectTable.tsx` and every use in `src/components/BulkActionsMenu.test.tsx`.

- [ ] **Step 2: Run the component tests to confirm the rename is complete**

Run: `npm run test:ui`
Expected: PASS. A miss shows up as a TypeScript error or a test that no longer renders the rename group.

- [ ] **Step 3: Write the failing tests for the loaner controls**

Append to `src/components/BulkActionsMenu.test.tsx`, following the file's existing patterns for mocking the actions and querying inside the popover. **Note the popover trap:** jsdom implements no Popover API and applies the UA `display: none`, so role queries against this panel need `{ hidden: true }` — copy exactly how the existing tests in this file query the audit and rename controls.

```tsx
describe("the loaner controls", () => {
  it("renders both buttons when the caller may manage items", () => {
    // ...render with canManageItems, then assert BOTH "Mark as loaner" and
    // "Remove loaner mark" are present, following this file's query style.
  });

  it("renders neither without MANAGE_ITEMS", () => {
    // ...render with canManageItems={false} and assert both are absent.
  });

  it("posts the ids and isLoaner=1 when marking", async () => {
    // ...click "Mark as loaner"; assert the mocked setItemsLoanerAction was
    // called with a FormData carrying the joined ids and isLoaner "1".
  });

  it("posts isLoaner=0 when removing the mark", async () => {
    // ...click "Remove loaner mark"; assert isLoaner "0".
  });
});
```

Fill each body in the style the surrounding tests already use — do not invent a new mocking approach for this file.

- [ ] **Step 4: Run them to verify they fail**

Run: `npx vitest run BulkActionsMenu`
Expected: FAIL — no such buttons.

- [ ] **Step 5: Add the loaner group**

In `src/components/BulkActionsMenu.tsx`, import the action:

```tsx
import { previewItemRenameAction, renameItemsAction, setItemsLoanerAction } from "@/app/admin/actions/items";
```

Add state beside the other groups' state:

```tsx
  // ONE message for both buttons, matching the queue pair above: they are two
  // ends of one job and are never used together, and this bar is sticky over
  // the table, where every line of height hides another row of what you are
  // selecting from.
  const [loanerMsg, setLoanerMsg] = useState<Msg>(null);
  // Two transitions, not one — a slow write must not point the busy state at
  // the button that was not pressed. Same reasoning as the three above.
  const [markPending, startMark] = useTransition();
  const [unmarkPending, startUnmark] = useTransition();
```

Render inside the `canManageItems` group, after the rename controls:

```tsx
              {/* No confirm: the audit control confirms because it writes
                  accountability records that cannot be undone. This writes one
                  reversible boolean, and its inverse is the next button. */}
              <button
                type="button"
                className="btn btn-secondary"
                disabled={markPending || unmarkPending || none}
                onClick={() =>
                  run(startMark, setLoanerMsg, { isLoaner: "1" }, setItemsLoanerAction, "Marked as loaner")
                }
              >
                {markPending ? "Marking…" : "Mark as loaner"}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={markPending || unmarkPending || none}
                onClick={() =>
                  run(startUnmark, setLoanerMsg, { isLoaner: "0" }, setItemsLoanerAction, "Removed the loaner mark from")
                }
              >
                {unmarkPending ? "Removing…" : "Remove loaner mark"}
              </button>
              {loanerMsg && (
                <span role={loanerMsg.ok ? "status" : "alert"} className={loanerMsg.ok ? "subtle" : "alert-error"}>{loanerMsg.text}</span>
              )}
```

**Check `run`'s signature before wiring this** — it is typed against `BulkResult` (`{ error } | { ok: true; updated; skipped }`). `setItemsLoanerAction` returns that shape plus `isLoaner`, which is a structural superset and should assign cleanly; if TypeScript disagrees, widen `run`'s `call` parameter rather than stripping the field from the action.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run BulkActionsMenu`
Expected: PASS.

Run: `npm run test:ui`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/BulkActionsMenu.tsx src/components/BulkActionsMenu.test.tsx \
        src/components/ItemSelectTable.tsx
git commit -m "feat(items): mark a selected batch as loaner stock"
```

---

### Task 5: Seeing it — the badge, the column, and the docs

**Files:**
- Modify: `src/components/items-view.ts`
- Modify: `src/components/items-view.test.ts`
- Modify: `src/components/ItemSelectTable.tsx`
- Modify: `src/components/ItemSelectTable.test.tsx`
- Modify: `src/app/items/page.tsx`
- Modify: `src/app/i/[itemId]/page.tsx`
- Modify: `src/app/globals.css`
- Modify: `CHANGELOG.md`, `.claude/rules/backend-constraints.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: `ItemRow` from `items-view.ts`.
- Produces: `ItemRow.isLoaner: boolean`; the `"loaner"` `ColumnKey`.

- [ ] **Step 1: Add the field and the column key**

In `src/components/items-view.ts`:

Add to `ItemRow`, after `storageLocation`:

```ts
  /** Pool stock — a device kept to lend out temporarily. Stored, not derived;
   *  see the note on the column in schema.prisma. */
  isLoaner: boolean;
```

Extend the column key union:

```ts
export type ColumnKey = SortField | "holder" | "lastSyncDateTime" | "loaner";
```

Add to `ITEM_COLUMNS` (after `status`):

```ts
  { key: "loaner", label: "Loaner" },
```

Add to `UNSORTABLE_COLUMNS`:

```ts
const UNSORTABLE_COLUMNS = new Set<string>(["holder", "lastSyncDateTime", "loaner"]);
```

A two-value sort is a filter wearing the wrong control — and `?loaner=1` is that filter. Update the `COLUMN_KEYS has 10 keys` comment above it to say **11**, and extend the doc comment on `ColumnKey` with a sentence naming `loaner` as the third displayable-but-unsortable column and why.

- [ ] **Step 2: Update the enumerating tests**

`src/components/items-view.test.ts` asserts the exact sortable set (around lines 113 and 118) and that `SORTABLE_COLUMNS` matches `ITEM_SORT_COLUMNS` (line 130). Add `"loaner"` to whichever list enumerates *unsortable* keys, and confirm the exact-equality assertions still hold — `loaner` must NOT appear in `SORTABLE_COLUMNS`.

Run: `npx vitest run items-view`
Expected: PASS.

- [ ] **Step 3: Render the column, the card badge, and the item page badge**

In `src/components/ItemSelectTable.tsx`, render a cell for the `loaner` column wherever the other conditional columns are rendered, following the existing pattern exactly (`visibleCols` drives it, and the cell carries `data-label="Loaner"` and `className="cell-desktop"` like its neighbours):

```tsx
{item.isLoaner ? <span className="badge badge-loaner">Loaner</span> : <span className="subtle">—</span>}
```

On the **mobile card**, put the badge in `td.cell-primary`, beside the device name — **not** in the More panel. That panel is at seven fields and `.claude/rules/ui-styling.md` records the measurement: an eighth "would put the tab's foot into the panel's SECOND row". Render it only when true (an em-dash on every non-loaner card is noise on a surface with no room).

In `src/app/i/[itemId]/page.tsx`, render the same badge next to the existing `<StatusBadge status={item.status} />` (currently line 98), only when `item.isLoaner`.

In `src/app/items/page.tsx`, add `isLoaner: it.isLoaner` to the object mapped into `<ItemSelectTable items={...}>`.

- [ ] **Step 4: Add the badge style**

In `src/app/globals.css`, add `.badge-loaner` beside the other `.badge-*` rules, following their shape. **Two standing rules apply:** `--muted` is a SURFACE tint and renders at 1.08:1 as text — muted text is `--text-muted`; and neither `next build` nor jsdom has a layout engine, so the contrast must be checked in a real browser (Task 6).

- [ ] **Step 5: Add table coverage**

In `src/components/ItemSelectTable.test.tsx`, extend the row factory with `isLoaner` and add: a marked row renders the badge; an unmarked row does not. Follow the file's existing query style.

Run: `npm run test:ui`
Expected: PASS.

- [ ] **Step 6: Update the changelog**

Add to `CHANGELOG.md` under today's `## 2026-08-11` heading, in the `### Added` subsection (create it in Keep a Changelog order if absent):

```markdown
- **Devices can be marked as loaners.** Scan or select a batch on the Items list, open **More actions**, and tap **Mark as loaner** — or **Remove loaner mark** to take them back out of the pool. Marked devices show a **Loaner** badge on their own page and in the list, and **Sort & filter** gains a *Loaners only* checkbox so the whole pool is one tap away.

  **The mark survives the nightly import.** It is a field of its own rather than a category or a storage location, which is why: those columns come from the spreadsheet, so an import would have quietly undone the mark within a day.

  #### Notes
  - Migration `20260811210000_item_is_loaner` adds the `Item.isLoaner` column (NOT NULL, default false) and its index. **Apply it to Supabase before merging**, per migrate-before-push: Prisma enumerates every column in its SELECT, so until the column exists *every* item read fails, not just the new control.
```

- [ ] **Step 7: Update the rule files**

In `.claude/rules/backend-constraints.md`, add the flag beside the derived-readiness material: what it is, that it is **stored** rather than derived and the test for why (nothing in the data can infer loaner-ness, so there is nothing to derive from and no second derivation to drift against), that **the importer must never learn to write it**, and that the bulk setter follows the retired-excluded-and-reported rule.

In `CLAUDE.md`, under *Backend Architecture & Feature Constraints*, add one line naming the flag and the distinction, and **add the caveat to the existing derived-readiness bullet** — as written, "Never reintroduce a hand-tickable flag" and this column read as a contradiction to anyone who has not opened the rule file.

- [ ] **Step 8: Commit**

```bash
git add src/components/items-view.ts src/components/items-view.test.ts \
        src/components/ItemSelectTable.tsx src/components/ItemSelectTable.test.tsx \
        src/app/items/page.tsx src/app/i/[itemId]/page.tsx src/app/globals.css \
        CHANGELOG.md .claude/rules/backend-constraints.md CLAUDE.md
git commit -m "feat(items): show the loaner mark on the item, the list and the card"
```

---

### Task 6: Verify

jsdom has no layout engine and no browser, so nothing above is evidence for the badge, the column or the card. This task is that evidence.

**Files:** none. Fix failures in the task they belong to and re-run.

- [ ] **Step 1: Full suite, build, lint**

Confirm no other session is using this repo first — `npm test` shares one database and `npm run build` runs `prisma generate` into a shared `node_modules`. If one is, stop and report rather than running these.

Run: `npm test` → expected PASS.
Run: `npm run build` → expected success.
Run: `npm run lint` → expected no new errors.

- [ ] **Step 2: Verify in a real browser at 1280px**

Start the dev server and sign in as an admin.

1. Select two devices on `/items`, open **More actions**, tap **Mark as loaner**. Confirm the outcome line names the count.
2. Confirm the **Loaner** column shows the badge for both, and that the Columns menu can hide and restore it.
3. Open **Sort & filter**, tick **Loaners only**, and confirm the list narrows to exactly those devices — then **type in the search box** and confirm the filter is still applied. That is the regression that has already lost two filters.
4. Sort by **Readiness** (a derived key, which forces the raw-SQL path) with the filter on, and confirm the same rows come back. This is the parity property in the real app.
5. Open one device's page and confirm the badge sits beside the status.
6. Tap **Remove loaner mark** and confirm all of the above reverses.
7. **Check the badge's contrast** against the ledger surface — `--muted` is a surface tint and renders invisible as text.

- [ ] **Step 3: Verify at 390px**

Resize to 390×844 with touch emulation.

1. Confirm the **Loaner** badge appears on a marked card beside the device name, and that an unmarked card shows nothing there.
2. **Re-measure the swipe tab's hit box** — `elementFromPoint` at the tab's top, centre and bottom must all return `button.swipe-grip`. The card grew, the tab is centred on the row, and `ui-styling.md` requires this measurement whenever that happens.
3. Confirm swipe-to-open and long-press-to-select still work on a marked card.

- [ ] **Step 4: Apply the migration to production BEFORE merging**

`next build` never runs `migrate deploy`, and Prisma enumerates every column in its SELECT — so if the branch merges before the column exists in Supabase, **every item read fails**, not just the loaner control.

Apply `20260811210000_item_is_loaner` to Supabase by hand, together with its `_prisma_migrations` row, in one transaction. The checksum is the sha of the **LF-normalised** file content. This step needs the repo owner: hand it to them rather than attempting it, and confirm it is done before the PR is merged.

- [ ] **Step 5: Report**

Report what each check did, including anything that did not behave as described. Do not claim the feature works on the strength of the test suite alone.

---

## Self-Review

**Spec coverage**

| Spec section | Task |
| --- | --- |
| §1 `Item.isLoaner`, default false, indexed, not importable | Task 1, Steps 1-3 |
| §1 The importer never writes it | Task 1, Step 8 (the test) |
| §2 `setItemsLoaner`, batched, retired excluded and reported, capped | Task 1, Step 6 |
| §3 `setItemsLoanerAction`, MANAGE_ITEMS, revalidates /items only | Task 2 |
| §4 The sheet's MANAGE_ITEMS group, prop renamed, two buttons, no confirm | Task 4 |
| §5 Badge on `/i/<id>`, hideable unsortable column, card badge not a panel row | Task 5, Steps 1-4 |
| §6 `?loaner=1` in both query paths, `ItemsPage` echo, page param, URL rebuild | Task 3 |
| Error handling — empty, over-cap, retired, missing capability, bad param | Task 1 Steps 4/6, Task 2 Steps 1/3, Task 3 Step 5 |
| Testing — DB, action, query parity, jsdom, browser | Tasks 1-5 respectively, Task 6 for the browser |
| Docs — CHANGELOG + Notes, SECURITY.md, rules, CLAUDE.md caveat | Task 2 Step 5, Task 5 Steps 6-7 |
| Migration + migrate-before-push | Task 1 Steps 2-3, Task 6 Step 4 |

**Type consistency.** `setItemsLoaner(itemIds, isLoaner) → { updated, skipped }` is spelled identically in Task 1 Step 6, Task 2 Step 3 and the interfaces blocks. `LoanerResult` adds `isLoaner` to the sheet's `BulkResult` shape, and Task 4 Step 5 names the assignability check that follows from it. `canManageItems` replaces `canRename` in Task 4 Step 1 and is used under that name in Steps 3 and 5. `ColumnKey` gains `"loaner"` in Task 5 Step 1 and is referenced nowhere earlier.

**Two places this plan deliberately does not restate code, and says so:** `commitImport`'s signature (Task 1 Step 8) and the session-mocking helpers in the two test files (Task 2 Step 1, Task 4 Step 3). Both are existing local conventions that a copied snippet would drift from; the implementer is told to read the neighbouring tests and follow them.
