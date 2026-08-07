# Storage location (SLoc) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `Item.storageLocation` — a free-text storage location imported from the fleet export's `SLoc` column, editable by admins, shown to signed-in staff on the item page, and matchable from the `/items` search box.

**Architecture:** One nullable text column on `Item`, threaded through the existing CSV import pipeline (parse → plan → write), the shared item-edit field set, the item detail card, and both halves of the `/items` search filter. No new tables, no new dependencies, no managed vocabulary. Every extension point already exists — this plan is mostly about hitting *all* of them, because several fail loudly (or silently) if missed.

**Tech Stack:** Next.js 16 (App Router, Server Actions), Prisma 7 + PostgreSQL, Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-07-sloc-storage-location-design.md`

## Global Constraints

- **Field name is `storageLocation`** in Prisma, TypeScript, Zod, form `name=` attributes and CSV canonical key. UI label is **"Storage location (SLoc)"**. Never `sloc` in code.
- **No `@map`.** The physical Postgres column must be `"storageLocation"`, because the raw-SQL search path names physical columns directly.
- **No index** is added for this column. This is deliberate — see the spec.
- **Accepted CSV header aliases: `sloc`, `storagelocation`, `storageloc` only.** A bare `location` alias is forbidden.
- **`docs/SECURITY.md` is NOT to be modified.** Nothing here touches authn/authz, crypto, retention, or the public surface. No watched file changes.
- **`CHANGELOG.md` must gain an entry under `## 2026-08-07`** before the final commit (project rule: docs ship in the same commit as the code).
- **Never run `npm test` while another agent may be running it** — parallel runs truncate the shared test database and produce fake failures in unrelated files. Run the targeted file, as each task specifies.
- **Prisma migrations:** `prisma migrate dev` cannot run non-interactively in this shell. Use `migrate diff --from-config-datasource --to-schema --script`, then `migrate deploy`.
- **Do not stage other files.** The working tree may carry another session's in-flight edits. Every commit step stages explicit paths only — never `git add -A` or `git add .`.
- **`npx tsc --noEmit` does NOT exit clean on this branch, and never did.** It reports **18 pre-existing errors** across exactly three files — `src/modules/audit/audit.service.test.ts`, `src/modules/service-queue/service-queue.service.test.ts`, `src/modules/transfers/transfers.service.test.ts` — all Prisma mock-typing noise in test files. CI does not run `tsc` at all (the three required checks are Semgrep SAST, `next build`, and the security-docs guard), which is how the debt accumulated. The baseline is saved at `.superpowers/sdd/2026-08-07-sloc-storage-location/tsc-baseline.txt`. **Wherever a task says to run `tsc --noEmit`, the pass condition is "no NEW error"** — no error naming `storageLocation`, and none in a file you touched. Compare against the baseline; do not try to reach zero, and do not "fix" those three files as a drive-by.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `prisma/schema.prisma` | Modify | Add the column. |
| `prisma/migrations/<ts>_item_storage_location/migration.sql` | Create | The DDL. |
| `src/modules/items/item-diff.ts` | Modify | Add to `ItemLoggedFields` so changes are recorded in history. |
| `src/modules/items/csv.ts` | Modify | Add to `RawRow`, `HEADER_MAP`, row mapping. |
| `src/modules/items/csv.test.ts` | **Modify (append)** | Header-aliasing tests. The file already exists with 15 tests — APPEND, never replace. |
| `src/modules/items/items.schema.ts` | Modify | Add to `importRowSchema`, `editableItemFields`, `newItemSchema`. |
| `src/modules/items/import.ts` | Modify | Add to `ExistingItem`, `NewItemImport`, both `planImport` branches. |
| `src/modules/items/items.service.ts` | Modify | `loadExistingBySerial` select, `UPDATABLE_ITEM_COLUMNS`, `ItemFieldSuggestions` + its query, both search filter paths. |
| `src/app/i/[itemId]/ItemDetailsCard.tsx` | Modify | Display row + admin-only edit input. |
| `src/app/i/[itemId]/page.tsx` | Modify | Pass the value through. |
| `src/app/admin/items/[itemId]/edit/EditItemForm.tsx` | Modify | Add the field. |
| `src/app/admin/items/new/NewItemForm.tsx` | Modify | Add the field. |
| `src/app/admin/items/import/ImportItemsForm.tsx` | Modify | Template CSV + on-screen column docs. |
| `CHANGELOG.md`, `CLAUDE.md` | Modify | Required docs. |

**Task order matters.** Task 1 (schema) unblocks everything. Tasks 2–4 are the import pipeline and must land together to be testable. Task 5 (edit surfaces) and Task 6 (search) are independent of each other.

---

### Task 1: Database column

**Files:**
- Modify: `prisma/schema.prisma` (the `model Item` block)
- Create: `prisma/migrations/<timestamp>_item_storage_location/migration.sql`

**Interfaces:**
- Produces: `Item.storageLocation: string | null` on the generated Prisma client. Every later task depends on this existing.

- [ ] **Step 1: Add the field to the schema**

In `prisma/schema.prisma`, inside `model Item`, immediately after the `deviceCategory` field and its comment block, add:

```prisma
  // Where the device physically sits when nobody is holding it — the fleet
  // export's "SLoc" column. Free text and NOT a managed vocabulary (unlike
  // deviceCategory/homeUnit): it is a lookup value read one item at a time,
  // with no analytics or filter grouping the fleet by it, so an unrecognised
  // SLoc arriving in a CSV must never fail a row.
  //
  // Deliberately NOT @map'd: the raw-SQL half of the /items search filter names
  // PHYSICAL columns, and currentUserEmail @map("currentUser") is the standing
  // example of what diverging names cost. Deliberately NOT indexed either — it
  // joins deviceName/make/model in an ILIKE '%q%' branch and none of those is
  // indexed; only serialNumber carries a trigram GIN, because it backs the
  // public per-keystroke search. Revisit if the fleet grows an order of
  // magnitude.
  storageLocation            String?
```

- [ ] **Step 2: Generate the migration SQL**

Run:

```bash
npx prisma migrate diff --from-config-datasource prisma/schema.prisma --to-schema prisma/schema.prisma --script
```

Expected output: a single `ALTER TABLE "Item" ADD COLUMN "storageLocation" TEXT;`

If the diff comes back empty, the schema edit did not save — re-check Step 1 before continuing.

- [ ] **Step 3: Create the migration directory and file**

Create `prisma/migrations/20260807000000_item_storage_location/migration.sql` containing:

```sql
-- The fleet export's "SLoc" column: where a device physically sits when
-- nobody holds it. Nullable free text, no index (see schema.prisma).
ALTER TABLE "Item" ADD COLUMN "storageLocation" TEXT;
```

- [ ] **Step 4: Apply it to the local dev database and regenerate the client**

Run:

```bash
npx prisma migrate deploy && npx prisma generate
```

Expected: `1 migration applied`, then `Generated Prisma Client`.

- [ ] **Step 5: Verify the column exists and TypeScript sees it**

Run:

```bash
npx tsc --noEmit
```

Expected: PASS (no errors). This proves the client regenerated — the field is not referenced anywhere yet, so this is purely a "did generate succeed" gate.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260807000000_item_storage_location/migration.sql
git commit -m "feat(items): add Item.storageLocation column"
```

---

### Task 2: CSV parsing — headers and row shape

**Files:**
- Modify: `src/modules/items/csv.ts`
- Modify (append only): `src/modules/items/csv.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 (this file is pure, no Prisma).
- Produces: `RawRow.storageLocation: string` (empty string when the column is absent). `planImport` in Task 3 reads it.

**Why these tests matter:** this module's failure mode is silent — an unrecognised header is ignored, so a broken alias map reports a *successful* import with the column quietly dropped. That is exactly how the `DeviceOwnershipUIC` bug reached production and left ~1,000 items with an empty UIC.

**⚠️ `csv.test.ts` ALREADY EXISTS — 121 lines, 15 tests, six commits of history. APPEND to it; never replace it.** Its existing tests guard the UIC alias set (including that production regression), the category aliases, the deliberate bare-`type` exclusion, quoted fields with embedded commas, blank-line skipping, and five error paths. Deleting any of them is a Critical defect: nothing fails, the suite simply covers less. An earlier draft of this plan wrongly said "Create" and claimed the file had no coverage — that was a plan error, and it cost a fix round.

- [ ] **Step 1: Write the failing test**

APPEND this block to the end of `src/modules/items/csv.test.ts`, leaving every existing test untouched:

```typescript
import { describe, it, expect } from "vitest";
import { parseItemsCsv } from "./csv";

describe("parseItemsCsv header aliasing", () => {
  it("maps every accepted spelling of the storage-location column", () => {
    for (const header of ["sloc", "SLoc", "S_Loc", "S Loc", "storageLocation", "Storage Location", "storageloc"]) {
      const { rows, error } = parseItemsCsv(`serialNumber,${header}\nABC123,Bldg 400 Cage 3\n`);
      expect(error, `header "${header}" failed to parse`).toBeUndefined();
      expect(rows[0]?.storageLocation, `header "${header}" did not map`).toBe("Bldg 400 Cage 3");
    }
  });

  it("IGNORES a bare `location` header", () => {
    // Deliberate: a fleet or MDM export can carry a generic "Location" column
    // meaning a geographic site. Aliasing it would overwrite every matched
    // device's storage location in one import and log that churn to history.
    const { rows, error } = parseItemsCsv("serialNumber,location\nABC123,Germany\n");
    expect(error).toBeUndefined();
    expect(rows[0]?.storageLocation).toBe("");
  });

  it("leaves storageLocation blank when the column is absent", () => {
    const { rows } = parseItemsCsv("serialNumber,make\nABC123,Dell\n");
    expect(rows[0]?.storageLocation).toBe("");
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run src/modules/items/csv.test.ts`

Expected: FAIL — `rows[0].storageLocation` is `undefined`, not `"Bldg 400 Cage 3"`.

- [ ] **Step 3: Add the field to `RawRow`**

In `src/modules/items/csv.ts`, add to the `RawRow` type after `deviceCategory: string;`:

```typescript
  storageLocation: string;
```

- [ ] **Step 4: Add the header aliases**

In the same file, in `HEADER_MAP`, after the category alias block, add:

```typescript
  // Storage location — the fleet export's "SLoc". normalizeHeader strips case
  // and non-alphanumerics, so "SLoc", "S_Loc", "S Loc" and "Storage Location"
  // all arrive here as one of these three keys.
  //
  // NOTE the deliberate absence of a bare `location` alias, for the same reason
  // a bare `type` is absent above: an MDM or fleet export can carry a generic
  // "Location" column holding a geographic site or building, and aliasing it
  // would overwrite every matched device's storage location in a single import
  // and log that churn to ItemEdit history. Keep the alias list explicit.
  sloc: "storageLocation",
  storagelocation: "storageLocation",
  storageloc: "storageLocation",
```

- [ ] **Step 5: Add it to the row mapping**

In `parseItemsCsv`'s `records.map(...)`, after `deviceCategory: r.deviceCategory ?? "",` add:

```typescript
    storageLocation: r.storageLocation ?? "",
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run src/modules/items/csv.test.ts`

Expected: PASS, **18 tests** — the 15 that already existed plus your 3. A run reporting only 3 means the pre-existing tests were replaced instead of appended; restore them from git before committing.

- [ ] **Step 7: Commit**

```bash
git add src/modules/items/csv.ts src/modules/items/csv.test.ts
git commit -m "feat(import): parse the SLoc storage-location column"
```

---

### Task 3: Import planning — schema, diff, and plan

**Files:**
- Modify: `src/modules/items/items.schema.ts` (`importRowSchema` only — the edit schemas come in Task 5)
- Modify: `src/modules/items/item-diff.ts` (`ItemLoggedFields`)
- Modify: `src/modules/items/import.ts` (`ExistingItem`, `NewItemImport`, both `planImport` branches)
- Test: `src/modules/items/item-diff.test.ts`, `src/modules/items/import.test.ts`

**Interfaces:**
- Consumes: `RawRow.storageLocation` from Task 2.
- Produces: `NewItemImport.storageLocation?: string`; `ItemUpdate.data.storageLocation`; `ItemLoggedFields.storageLocation`. Task 4 writes these to the database.

- [ ] **Step 1: Write the failing diff test**

Append to `src/modules/items/item-diff.test.ts`:

```typescript
describe("storageLocation", () => {
  it("records a change", () => {
    const changes = diffItemFields({ storageLocation: "Bldg 400" }, { storageLocation: "Bldg 401" });
    expect(changes).toEqual([{ field: "storageLocation", from: "Bldg 400", to: "Bldg 401" }]);
  });

  it("records a clear-to-null when the submitted value is blank", () => {
    const changes = diffItemFields({ storageLocation: "Bldg 400" }, { storageLocation: "" });
    expect(changes).toEqual([{ field: "storageLocation", from: "Bldg 400", to: null }]);
  });

  it("reports no change when the value is absent (not submitted)", () => {
    expect(diffItemFields({ storageLocation: "Bldg 400" }, {})).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run src/modules/items/item-diff.test.ts`

Expected: FAIL — a TypeScript error that `storageLocation` is not a key of `ItemLoggedFields`.

- [ ] **Step 3: Add the field to `ItemLoggedFields`**

In `src/modules/items/item-diff.ts`, add to the `ItemLoggedFields` type after `deviceCategory: string | null;`:

```typescript
  storageLocation: string | null;
```

- [ ] **Step 4: Run the diff test to verify it passes**

Run: `npx vitest run src/modules/items/item-diff.test.ts`

Expected: PASS.

- [ ] **Step 5: Write the failing import-planning tests**

Append to `src/modules/items/import.test.ts`. The row and map literals below are complete — every key of `RawRow` and `ExistingItem` is present — so they compile as written. If the existing file already has a row-building helper, prefer it for consistency, but do not block on finding one.

```typescript
describe("storageLocation", () => {
  it("sets it on a newly created item", () => {
    const rows = [{ row: 1, make: "Dell", model: "5540", serialNumber: "NEW-1", deviceName: "", homeUnit: "", deviceUIC: "", deviceCategory: "", storageLocation: "Bldg 400 Cage 3", notes: "", assignedUser: "", lastLogonUserPrincipalName: "", lastLogonDate: "", enrollmentDate: "", compliance: "" }];
    const plan = planImport(rows, new Map(), new Map());
    expect(plan.toCreate[0]?.storageLocation).toBe("Bldg 400 Cage 3");
  });

  it("OVERWRITES the stored value on a matched row, and logs the change", () => {
    const existing = new Map([["old-1", {
      id: "i1", status: "ACTIVE", make: "Dell", model: "5540", deviceName: "N1",
      homeUnit: null, deviceUIC: null, deviceCategory: null, storageLocation: "Bldg 400",
      currentUserEmail: null, lastLogonUserPrincipalName: null, lastLogonDate: null,
      enrollmentDate: null, compliance: null,
    }]]);
    const rows = [{ row: 1, make: "", model: "", serialNumber: "OLD-1", deviceName: "", homeUnit: "", deviceUIC: "", deviceCategory: "", storageLocation: "Bldg 401", notes: "", assignedUser: "", lastLogonUserPrincipalName: "", lastLogonDate: "", enrollmentDate: "", compliance: "" }];
    const plan = planImport(rows, existing, new Map());
    expect(plan.toUpdate[0]?.data.storageLocation).toBe("Bldg 401");
    expect(plan.toUpdate[0]?.loggedChanges).toContainEqual({ field: "storageLocation", from: "Bldg 400", to: "Bldg 401" });
  });

  it("leaves the stored value untouched when the cell is blank", () => {
    const existing = new Map([["old-2", {
      id: "i2", status: "ACTIVE", make: "Dell", model: "5540", deviceName: "N2",
      homeUnit: null, deviceUIC: null, deviceCategory: null, storageLocation: "Bldg 400",
      currentUserEmail: null, lastLogonUserPrincipalName: null, lastLogonDate: null,
      enrollmentDate: null, compliance: null,
    }]]);
    const rows = [{ row: 1, make: "", model: "", serialNumber: "OLD-2", deviceName: "", homeUnit: "", deviceUIC: "", deviceCategory: "", storageLocation: "", notes: "", assignedUser: "", lastLogonUserPrincipalName: "", lastLogonDate: "", enrollmentDate: "", compliance: "" }];
    const plan = planImport(rows, existing, new Map());
    expect(plan.unchanged).toHaveLength(1);
    expect(plan.toUpdate).toHaveLength(0);
  });

  it("writes no history row for a RETIRED item, but still updates the column", () => {
    const existing = new Map([["ret-1", {
      id: "i3", status: "RETIRED", make: "Dell", model: "5540", deviceName: "N3",
      homeUnit: null, deviceUIC: null, deviceCategory: null, storageLocation: "Bldg 400",
      currentUserEmail: null, lastLogonUserPrincipalName: null, lastLogonDate: null,
      enrollmentDate: null, compliance: null,
    }]]);
    const rows = [{ row: 1, make: "", model: "", serialNumber: "RET-1", deviceName: "", homeUnit: "", deviceUIC: "", deviceCategory: "", storageLocation: "Bldg 401", notes: "", assignedUser: "", lastLogonUserPrincipalName: "", lastLogonDate: "", enrollmentDate: "", compliance: "" }];
    const plan = planImport(rows, existing, new Map());
    expect(plan.toUpdate[0]?.data.storageLocation).toBe("Bldg 401");
    expect(plan.toUpdate[0]?.loggedChanges).toEqual([]);
  });
});
```

- [ ] **Step 6: Run them to make sure they fail**

Run: `npx vitest run src/modules/items/import.test.ts`

Expected: FAIL — `plan.toCreate[0].storageLocation` is `undefined`.

- [ ] **Step 7: Add it to `importRowSchema`**

In `src/modules/items/items.schema.ts`, in `importRowSchema`, after `deviceCategory: categoryOptional,` add:

```typescript
  storageLocation: optional,
```

`optional` maps a blank cell to `undefined`, which `diffItemFields` reads as "not submitted" — so a blank leaves the stored value alone, matching every other imported column.

- [ ] **Step 8: Add it to the import types**

In `src/modules/items/import.ts`:

Add to the `ExistingItem` type after `deviceCategory: string | null;`:

```typescript
  storageLocation: string | null;
```

Add to the `NewItemImport` type after `deviceCategory?: string;`:

```typescript
  storageLocation?: string;
```

- [ ] **Step 9: Thread it through `planImport`**

In `planImport`, add to the `importRowSchema.safeParse({ ... })` argument object, after `deviceCategory: r.deviceCategory,`:

```typescript
      storageLocation: r.storageLocation,
```

In the UPDATE branch, alongside the other `loggedAfter` assignments (after the `deviceCategory` line), add:

```typescript
      if (d.storageLocation !== undefined) loggedAfter.storageLocation = d.storageLocation;
```

In the CREATE branch, in the `const item: NewItemImport = { ... }` literal, after `deviceCategory: d.deviceCategory,`, add:

```typescript
      storageLocation: d.storageLocation,
```

Putting it in `loggedAfter` (not `silentAfter`) is what makes an import-driven change appear in the item's history, and it inherits the existing RETIRED-writes-no-history rule for free.

- [ ] **Step 10: Run both test files to verify they pass**

Run: `npx vitest run src/modules/items/import.test.ts src/modules/items/item-diff.test.ts`

Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add src/modules/items/items.schema.ts src/modules/items/item-diff.ts src/modules/items/import.ts src/modules/items/import.test.ts src/modules/items/item-diff.test.ts
git commit -m "feat(import): plan storage-location creates and updates"
```

---

### Task 4: Import writing — the service layer

**Files:**
- Modify: `src/modules/items/items.service.ts` (`loadExistingBySerial`, `UPDATABLE_ITEM_COLUMNS`)

**Interfaces:**
- Consumes: `ItemUpdate.data.storageLocation` from Task 3.
- Produces: a working end-to-end import. Nothing later depends on new names.

**This task is where a miss fails loudly.** `UPDATABLE_ITEM_COLUMNS` is an allowlist guarding a SQL-identifier interpolation in the batched UPDATE. `planImport` now emits `storageLocation`, so if the allowlist does not contain it, every import carrying an SLoc throws `Refusing to update unknown column(s): storageLocation`.

- [x] **Step 1: Add the column to the read** — **ALREADY DONE in Task 3 (commit `d805774`).**

`loadExistingBySerial`'s `select` already carries `storageLocation: true`. Task 3 was forced to add it: making `ExistingItem.storageLocation` a required field broke that select immediately, so the one-line read change came forward with it. Verify it is present, then move to Step 2 — do not re-add it.

For the record of why it matters: without it, `ExistingItem.storageLocation` is always `undefined` and `diffItemFields` compares against nothing, so every import reports a change and rewrites the same value, logging a bogus history row each time.

- [ ] **Step 2: Add the column to the write allowlist**

In `UPDATABLE_ITEM_COLUMNS`, after `"deviceCategory",` add:

```typescript
  "storageLocation",
```

No `FIELD_TO_COLUMN` entry is needed — the field is not `@map`'d, so the field name *is* the physical column name. No `COLUMN_CAST` entry is needed either — it is text, and `castFor` defaults to `text`.

- [ ] **Step 3: Verify the import suite still passes — including the real-DB file**

Run: `npx vitest run src/modules/items/import.test.ts src/modules/items/items.service.import.test.ts`

Expected: PASS.

**`items.service.import.test.ts` is the file that matters here and it is easy to miss.** It is the only one that calls `commitImport` against a real database, so it is the only one that runs the batched UPDATE and therefore the only one that touches the allowlist. `import.test.ts` exercises `planImport`, which is pure — a storage-location test there passes whether or not Step 2 was done. An earlier draft of this plan named `items.service.test.ts` here instead, which is why the missing coverage went unnoticed until review.

- [ ] **Step 3b: Add the test that would catch a missing allowlist entry**

Append to `src/modules/items/items.service.import.test.ts` (9 existing tests — append, do not replace), mirroring the existing `"commitImport overwrites an existing item's homeUnit from the CSV and logs the change"` test: create an item with a `storageLocation`, `commitImport` a CSV using the `SLoc` header carrying a different value, then assert **the persisted row** holds the new value and that an `ItemEdit` records the change.

Prove it bites: temporarily remove `"storageLocation",` from `UPDATABLE_ITEM_COLUMNS`, confirm the test FAILS with "Refusing to update unknown column(s)", then restore it.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`

Expected: the 18 pre-existing baseline errors and **no new one** — nothing naming `storageLocation`, nothing in `items.service.ts`. See Global Constraints.

- [ ] **Step 5: Commit**

```bash
git add src/modules/items/items.service.ts
git commit -m "feat(import): write storage location on create and update"
```

---

### Task 5: Edit and display surfaces

**Files:**
- Modify: `src/modules/items/items.schema.ts` (`editableItemFields`, `newItemSchema`)
- Modify: `src/modules/items/items.service.ts` (`ItemFieldSuggestions`, `listItemFieldSuggestions`)
- Modify: `src/app/i/[itemId]/ItemDetailsCard.tsx`, `src/app/i/[itemId]/page.tsx`
- Modify: `src/app/admin/items/[itemId]/edit/EditItemForm.tsx`, `src/app/admin/items/new/NewItemForm.tsx`

**Interfaces:**
- Consumes: `Item.storageLocation` from Task 1.
- Produces: `ItemFieldSuggestions` gains a `storageLocation: string[]` member — every existing construction site of that object must be updated or TypeScript fails.

- [ ] **Step 1: Add it to the shared editable field set**

In `src/modules/items/items.schema.ts`, in `editableItemFields`, after `deviceCategory: categoryClearable,` add:

```typescript
  storageLocation: clearable,
```

`clearable`, not `optional`: a blank input must stay `""` so emptying the box records a clear-to-null instead of reading as "not submitted" and silently no-opping.

This one edit gives both admin surfaces the field at once — `adminItemEditSchema` and `itemDetailsSchema` are both built from this object. **Do not add it to `userItemDetailsSchema`**; a standard USER still edits exactly two fields.

- [x] **Step 2: Add it to the create schema** — **ALREADY DONE in Task 4's fix round (commit `68d25b9`).**

`newItemSchema` already carries `storageLocation: optional,` after `deviceCategory: categoryNew,`. Task 4's real-DB test had to create an item holding a storage location, and `createItem` re-parses its input through `newItemSchema`, so the line came forward with it. Verify it is present and move on — do not re-add it.

For the record of why that helper: `optional`, not `clearable` — a row that does not exist yet has no value to clear, and writing `""` puts an empty string where every filter would treat it as a value.

- [ ] **Step 3: Extend the suggestion vocabulary**

In `src/modules/items/items.service.ts`, change the `ItemFieldSuggestions` type to:

```typescript
export type ItemFieldSuggestions = { make: string[]; model: string[]; deviceUIC: string[]; storageLocation: string[] };
```

Add a fourth arm to the `$queryRaw` UNION in `listItemFieldSuggestions`, after the `deviceUIC` arm:

```sql
    UNION ALL
    (SELECT 'storageLocation' AS field, "storageLocation" AS value, COUNT(*)::int AS n
       FROM "Item" WHERE btrim(COALESCE("storageLocation", '')) <> ''
       GROUP BY "storageLocation" ORDER BY n DESC, value ASC LIMIT ${SUGGESTION_CAP})
```

and add `storageLocation: bucket("storageLocation"),` to the returned object.

- [ ] **Step 4: Fix every other construction of that type**

Run:

```bash
npx tsc --noEmit
```

Expected: NEW errors — beyond the 18 baseline ones — at each site that builds an `ItemFieldSuggestions` literal. At minimum `src/app/i/[itemId]/page.tsx:72` has `{ make: [], model: [], deviceUIC: [] }` — add `storageLocation: []`. Fix each reported site the same way, then re-run until only the 18 baseline errors remain. Do not touch the three baseline files.

- [ ] **Step 5: Add the display row and edit input to the item card**

In `src/app/i/[itemId]/ItemDetailsCard.tsx`:

Add to the `ItemDetailsValues` type after `deviceCategory: string | null;`:

```typescript
  storageLocation: string | null;
```

Inside the `{isAdmin && (<>…</>)}` block in the form, after the Category field, add:

```tsx
                <div className="field">
                  <label className="label" htmlFor="ed-storageLocation">Storage location (SLoc)</label>
                  <SuggestCombobox
                    id="ed-storageLocation"
                    name="storageLocation"
                    options={suggestions.storageLocation}
                    placeholder="e.g. Bldg 400 Cage 3"
                    defaultValue={item.storageLocation ?? ""}
                  />
                </div>
```

In the read-only `<dl>`, after the Category `<dd>`, add:

```tsx
          <dt>Storage location</dt>
          <dd>{item.storageLocation || dash}</dd>
```

**Not wrapped in `isAdmin`.** Any signed-in user may *read* the location; only admins may edit it. That asymmetry is fine and is enforced server-side by `updateItemDetailsAction` picking `userItemDetailsSchema` for a non-admin, which strips the field. Unlike `notes`, the value needs no server-side prop gate — the whole card is already inside `{loggedIn && …}`.

- [ ] **Step 6: Pass the value from the page**

In `src/app/i/[itemId]/page.tsx`, in the `<ItemDetailsCard item={{…}}>` literal, after `deviceCategory: item.deviceCategory,` add:

```tsx
              storageLocation: item.storageLocation,
```

- [ ] **Step 7: Add the field to both admin forms**

In `src/app/admin/items/[itemId]/edit/EditItemForm.tsx`: add `storageLocation: string | null;` to `ItemValues`; add `["storageLocation", "Storage location (SLoc)", false],` to the `fields` array after the `deviceCategory` entry; and add `storageLocation: suggestions.storageLocation,` to `optionsFor`.

In `src/app/admin/items/new/NewItemForm.tsx`: add `["storageLocation", "Storage location (SLoc)", false],` to `fields` after the `deviceCategory` entry, and `storageLocation: suggestions.storageLocation,` to `optionsFor`.

Every field a form renders **must** be declared in the schema — `z.object()` strips undeclared keys, so a rendered-but-undeclared field saves nothing while reporting "Saved". Step 1 and Step 2 are what make these two safe.

- [ ] **Step 8: Pin the three schemas' differing blank-handling**

The same field is declared three ways on purpose, and the differences are invisible at a glance. Append to `src/modules/items/items.schema.test.ts`:

```typescript
describe("storageLocation across the three schemas", () => {
  it("keeps a blank as \"\" on the edit schema, so emptying the box CLEARS it", () => {
    const parsed = adminItemEditSchema.parse({
      deviceName: "N1", homeUnit: "", deviceUIC: "", currentUserEmail: "",
      currentPosition: "", notes: "", deviceCategory: "", storageLocation: "  ",
    });
    expect(parsed.storageLocation).toBe("");
  });

  it("maps a blank to undefined on the import schema, so it leaves the stored value alone", () => {
    const parsed = importRowSchema.parse({ serialNumber: "ABC123", storageLocation: "  " });
    expect(parsed.storageLocation).toBeUndefined();
  });

  it("maps a blank to undefined on the create schema", () => {
    const parsed = newItemSchema.parse({
      make: "Dell", model: "5540", serialNumber: "ABC123", deviceName: "N1", storageLocation: "",
    });
    expect(parsed.storageLocation).toBeUndefined();
  });

  it("trims a real value on every one of them", () => {
    expect(importRowSchema.parse({ serialNumber: "A", storageLocation: " Bldg 400 " }).storageLocation).toBe("Bldg 400");
    expect(newItemSchema.parse({ make: "D", model: "5", serialNumber: "A", deviceName: "N", storageLocation: " Bldg 400 " }).storageLocation).toBe("Bldg 400");
  });
});
```

Add `adminItemEditSchema` and `newItemSchema` to the file's existing import from `./items.schema` if they are not already imported.

Run: `npx vitest run src/modules/items/items.schema.test.ts`

Expected: PASS. If the first case returns `undefined` instead of `""`, Step 1 used `optional` where it needed `clearable` — that is the silent "reported Saved but changed nothing" bug.

- [ ] **Step 9: Typecheck and run the component tests**

Run:

```bash
npx tsc --noEmit; npm run test:ui
```

Expected: `tsc` reports only the 18 baseline errors (see Global Constraints — it does not exit 0, which is why these are two statements and not `&&`); `test:ui` PASSES.

- [ ] **Step 10: Commit**

```bash
git add src/modules/items/items.schema.ts src/modules/items/items.schema.test.ts src/modules/items/items.service.ts "src/app/i/[itemId]/ItemDetailsCard.tsx" "src/app/i/[itemId]/page.tsx" "src/app/admin/items/[itemId]/edit/EditItemForm.tsx" src/app/admin/items/new/NewItemForm.tsx
git commit -m "feat(items): edit and display the storage location"
```

---

### Task 6: `/items` search — both paths

**Files:**
- Modify: `src/modules/items/items.service.ts` (`listItems`'s Prisma `where`, `itemFilterSql`)
- Test: `src/modules/items/items.readiness-sort.parity.test.ts`

**Interfaces:**
- Consumes: `Item.storageLocation` from Task 1.
- Produces: nothing new.

**The whole risk here is the two paths drifting.** A sort naming a derived key (`readiness`, `auditState`) runs a raw `$queryRaw`; every other sort uses Prisma. Both implement `?q=` separately, and a drifted filter is invisible — the table shows a different catalogue depending on which column you sorted by.

- [ ] **Step 1: Write the failing parity case**

In `src/modules/items/items.readiness-sort.parity.test.ts`:

Add `storageLocation` to the `Seed` type:

```typescript
  storageLocation?: string | null;
```

Give exactly one seed a location containing the existing search term and no other match, by changing the `${PREFIX}11` row to include:

```typescript
  storageLocation: "Delta Cage 7",
```

Note `${PREFIX}11` currently matches nothing for the term "delta" — its serial, make (`Dell`), model (`5540`) and device name (`Node eleven`) all miss. That is what makes it a real test: it can only appear in the results via the new branch.

Add the seed value to wherever the test creates its rows (find the `prisma.item.create`/`createMany` call in `beforeAll` and pass `storageLocation: s.storageLocation ?? null`).

Add a filter case to the list of combinations the two paths must agree on:

```typescript
  { name: "search matches only a storage location", search: "cage", uic: null, size: 1 },
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run src/modules/items/items.readiness-sort.parity.test.ts`

Expected: FAIL — the case asserting `size: 1` gets 0 results, because neither path searches the column yet.

- [ ] **Step 3: Add the Prisma branch**

In `listItems`, in the `filters.push({ OR: [ … ] })` array, after the `serialNumber` entry add:

```typescript
        { storageLocation: { contains: search, mode: "insensitive" } },
```

- [ ] **Step 4: Add the raw-SQL branch**

In `itemFilterSql`, after the `serialNumber` line add:

```typescript
      OR i."storageLocation" ILIKE ${pattern}::text
```

The value is a bound parameter, never interpolated. No `::text` cast is needed on the column itself — unlike `serialNumber`, this is a plain `text` column, not `citext`.

- [ ] **Step 5: Run the parity test to verify it passes**

Run: `npx vitest run src/modules/items/items.readiness-sort.parity.test.ts`

Expected: PASS — every filter case returns identical ids from both paths.

- [ ] **Step 6: Run the wider items suite**

Run:

```bash
npx vitest run src/modules/items/
```

Expected: PASS. Confirm no other agent is running the suite first — parallel runs truncate the shared test database.

- [ ] **Step 7: Commit**

```bash
git add src/modules/items/items.service.ts src/modules/items/items.readiness-sort.parity.test.ts
git commit -m "feat(items): match storage location in the /items search"
```

---

### Task 7: Documentation

**Files:**
- Modify: `src/app/admin/items/import/ImportItemsForm.tsx` (template + on-screen docs)
- Modify: `CHANGELOG.md`, `CLAUDE.md`

- [ ] **Step 1: Update the downloadable CSV template**

In `ImportItemsForm.tsx`, change the `TEMPLATE` constant to include the new column — add `,storageLocation` to the header line after `deviceUIC`, and a matching example value to the data line:

```typescript
export const TEMPLATE =
  "make,model,serialNumber,deviceName,deviceType,homeUnit,deviceUIC,storageLocation,notes,assignedUser,lastLogonUserPrincipalName,lastLogonDate,enrollmentDate,compliance\n" +
  "Dell Inc.,Latitude 5540,ABC1234,NGHINB-EXAMPLE-01,Laptop,A CO 1-234 IN,W6BTAA,Bldg 400 Cage 3,,soldier@army.mil,soldier@army.mil,7/25/2026 1:40:21 AM,5/1/2025 2:23:41 AM,compliant\n";
```

- [ ] **Step 2: Update the on-screen column list**

In the same file's `<strong>Columns:</strong>` paragraph, add after the `deviceUIC` clause:

```tsx
              <strong>storageLocation</strong> (where the device is stored; also
              accepts <code>SLoc</code> or <code>storageLoc</code>),
```

And extend the paragraph about the ignored `type` column with a second sentence:

```tsx
              A generic <code>location</code> column is ignored for the same reason —
              fleet exports use it for a geographic site, not a storage location.
```

- [x] **Step 3: Add the changelog entry** — **ALREADY DONE in Task 5 (commit `d93b5ff`).**

`CHANGELOG.md` already carries an entry under `## 2026-08-07` → `### Added`. **Do not add a second one.**

Instead, **review the existing entry and extend it** so it covers what Tasks 6 and 7 added, which it was written before: that the `/items` search box now matches a storage location, and that a blank cell in a CSV leaves the stored value untouched (clearing one is done from the item's edit form). Keep it one entry, describing the behavior for a reader rather than the diff.

- [ ] **Step 4: Document the header-alias rule**

In `CLAUDE.md`, in the Categories bullet's `**CSV header:**` sub-bullet (which already explains why a bare `type` is not aliased), add a sibling sub-bullet under the same section:

```markdown
  * **Storage location** (`Item.storageLocation`) fills from **`SLoc`** (also `storageLocation` / `storageLoc`). A bare **`location`** is deliberately NOT aliased, for the same reason as a bare `type`: fleet exports carry a generic "Location" column meaning a geographic site, and aliasing it would overwrite every matched item's storage location and log the churn to `ItemEdit`. It is plain free text with no managed vocabulary and no index — unlike `deviceCategory`/`homeUnit`, nothing groups the fleet by it. Adding an importable column also means adding it to **`UPDATABLE_ITEM_COLUMNS`** in `items.service.ts` (the allowlist guarding the batched UPDATE's identifier splice) and to `loadExistingBySerial`'s `select`, or every import carrying it throws.
```

- [ ] **Step 4b: Fix every stale "seven fields" claim — the editable set is now EIGHT**

`editableItemFields` grew from seven fields to eight. Five places still say seven, and this project treats a doc that describes code which no longer exists as a defect, not a nitpick. Update all five:

1. **`CLAUDE.md` line ~72** — the §1 bullet "The two item-edit surfaces share ONE field definition" says "**exactly seven fields**" and then enumerates them. Change to **eight** and add `storageLocation` to the list. This is the most important of the five: it is the guide a future reader trusts, and it currently understates the editable set.
2. `src/modules/items/items.schema.ts:112` — "seven-field editable set" in the `itemIdentitySchema` doc comment.
3. `src/modules/items/items.schema.ts:168` — "the seven fields both edit surfaces expose" in the `editableItemFields` doc comment.
4. `src/modules/items/items.schema.test.ts:40` — test title `"round-trips all seven editable fields"`.
5. `src/modules/items/items.schema.test.ts:147` — test title `"strips the seven editable fields — this form corrects identity ONLY"`.

Do NOT change any assertion — both tests derive from the `EDITABLE_FIELDS` constant, which was already grown correctly. These are names and prose only.

- [ ] **Step 5: Confirm the security-docs guard is not triggered**

Run: `npm run check:security-docs`

Expected: PASS without requiring a `docs/SECURITY.md` edit. If it fails, a watched file was modified — stop and reconsider rather than editing `docs/SECURITY.md` to appease it.

- [ ] **Step 6: Commit**

```bash
git add src/app/admin/items/import/ImportItemsForm.tsx CHANGELOG.md CLAUDE.md
git commit -m "docs(items): document the SLoc storage-location column"
```

---

### Task 8: Full verification

- [ ] **Step 1: Typecheck and lint**

Run: `npx tsc --noEmit; npm run lint`

Expected: `tsc` reports only the 18 baseline errors and no new one (see Global Constraints); `lint` PASSES. Note `next build` — Step 3 — is the check CI actually gates on.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`

Expected: PASS. **Confirm no other agent is running tests first** — concurrent runs truncate the shared test database and produce failures in files unrelated to this change.

- [ ] **Step 3: Build**

Run: `npm run build`

Expected: PASS.

- [ ] **Step 4: Verify in a real browser**

`npm run build` and jsdom are not evidence for UI work. Start the dev server, sign in as an admin, and confirm end to end:

1. `/admin/items/import` — download the template, add a row with an `SLoc` value for an existing serial, upload it, and confirm the import reports 1 updated.
2. `/i/<that item>` — the Storage location row shows the new value, and the item's edit history records the change.
3. Edit the item, change the location, save — the value updates and the combobox offers locations already in use.
4. `/items?q=<part of the location>` — the item appears. Add `&sort=readiness` to the URL and confirm the **same** item still appears; that is the raw-SQL path, and it is the drift this whole task guarded against.
5. Sign out, open `/i/<that item>` — confirm **no** storage location is visible.

- [ ] **Step 5: Apply the migration to production before merging**

The migration must reach Supabase *before* the merge deploys — a bare `next build` never runs `migrate deploy`, so deployed code selecting a column that does not exist yet will break. See `DEPLOY.md` and the migrate-before-push rule in `CLAUDE.md`.

---

## Notes for the implementer

- **`/items` currently has no Storage location column, deliberately.** The field is searchable but not displayed in the list and not sortable. Do not add it to `sort-keys.ts` or `items-view.ts` — that was scoped out.
- **`userItemDetailsSchema` stays at two fields.** If you find yourself adding `storageLocation` to it, stop: that is an authorization widening the spec explicitly rejected.
- **The working tree may hold another session's edits.** Every commit above stages explicit paths. Never `git add -A`.
