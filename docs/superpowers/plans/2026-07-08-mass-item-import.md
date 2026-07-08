# Mass Item Import (CSV) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin upload a CSV of items to create them in bulk, skipping duplicate serial numbers (checked against the DB and within the file), reporting what was skipped, and recording each import in the audit log.

**Architecture:** Two pure modules — `csv.ts` (parse + header-normalize via `csv-parse`) and `import.ts` (`planImport`: validate + dedup) — feed a DB-touching `importItems` service that writes valid rows with `createMany` and an `ImportBatch` audit record in one transaction. An admin page uploads the file; the audit page gains a "CSV imports" section.

**Tech Stack:** Next.js 16 (App Router, Server Actions), Prisma 7, PostgreSQL, Zod, `csv-parse` v7, Vitest.

## Global Constraints

- **Admin-only:** every new Server Action starts with `const admin = await requireAdmin();`. The `/admin/items/import` page lives under the `/admin` layout, which already gates admin access.
- **Prisma parameterized only:** no string-interpolated SQL.
- **Generic client errors:** actions catch unexpected errors, return a generic message, `console.error` detail server-side.
- **Dedup is application-level:** serials compared **case-sensitively on the trimmed value**; `Item.serialNumber` stays non-unique in the DB.
- **Row cap:** 2,000 data rows per import; over that → reject with a message, import nothing.
- **CSV headers:** required `make, model, serialNumber`; optional `homeUnit, notes`. Matched case-insensitively, order-independent; `serial`/`serial number` alias `serialNumber`.
- **Deploy rule:** the `ImportBatch` migration must be applied to Supabase via `db:deploy` BEFORE pushing.
- **Test runner:** `npx vitest run <path>`. Pure tests need no DB. Item-service tests use the real test DB harness (`migrateTestDb`/`resetDb` from `tests/helpers/db`, `DATABASE_URL` → `handreceipt_test`), following `src/modules/items/items.service.search.test.ts`.
- **Commit trailer:** end every commit body with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

**Create:**
- `src/modules/items/csv.ts` — parse CSV text → normalized row objects; parse/format errors.
- `src/modules/items/csv.test.ts`
- `src/modules/items/import.ts` — `planImport`: per-row validation + dedup planning (pure, no DB).
- `src/modules/items/import.test.ts`
- `src/modules/items/items.service.import.test.ts` — real-DB test for `importItems`.
- `src/app/admin/items/import/page.tsx` — admin upload page.
- `src/app/admin/items/import/ImportItemsForm.tsx` — client form + result UI.
- `prisma/migrations/<ts>_import_batch/migration.sql` — additive `ImportBatch` table.

**Modify:**
- `prisma/schema.prisma` — add `ImportBatch` model + `User.importBatches` relation.
- `src/modules/items/items.service.ts` — add `importItems`.
- `src/app/admin/actions/items.ts` — add `importItemsAction`.
- `src/app/admin/audit/page.tsx` — add "CSV imports" section.
- `src/app/items/page.tsx` — add admin "Import CSV" link.
- `src/app/admin/items/new/page.tsx` — add "Import CSV" link.

---

## Task 1: CSV parser (`csv.ts`)

**Files:**
- Create: `src/modules/items/csv.ts`, `src/modules/items/csv.test.ts`
- Modify: `package.json` (add `csv-parse` dependency)

**Interfaces:**
- Produces:
  - `MAX_IMPORT_ROWS = 2000`
  - `type RawRow = { row: number; make: string; model: string; serialNumber: string; homeUnit: string; notes: string }`
  - `parseItemsCsv(text: string): { rows: RawRow[]; error?: string }`

- [ ] **Step 1: Install the dependency**

Run: `npm install csv-parse`
Expected: `csv-parse` (v7.x) added to `dependencies` in `package.json`. (Already validated healthy via `npm view csv-parse` — v7.0.1, MIT.)

- [ ] **Step 2: Write the failing test**

```typescript
// src/modules/items/csv.test.ts
import { describe, it, expect } from "vitest";
import { parseItemsCsv, MAX_IMPORT_ROWS } from "./csv";

describe("parseItemsCsv", () => {
  it("parses rows and maps case-insensitive, aliased headers", () => {
    const csv = "Make,Model,Serial Number,Home Unit,Notes\nM4,Carbine,A1,A Co,tan\n";
    const { rows, error } = parseItemsCsv(csv);
    expect(error).toBeUndefined();
    expect(rows).toEqual([
      { row: 1, make: "M4", model: "Carbine", serialNumber: "A1", homeUnit: "A Co", notes: "tan" },
    ]);
  });

  it("handles quoted fields with embedded commas and skips blank lines", () => {
    const csv = 'make,model,serialNumber,notes\nM4,Carbine,A1,"tan, worn"\n\nPVS,14,B7,\n';
    const { rows } = parseItemsCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0].notes).toBe("tan, worn");
    expect(rows[1]).toMatchObject({ row: 2, make: "PVS", serialNumber: "B7", notes: "" });
  });

  it("errors when a required header is missing", () => {
    const { error } = parseItemsCsv("make,model\nM4,Carbine\n");
    expect(error).toMatch(/serialNumber/);
  });

  it("errors on an empty file", () => {
    expect(parseItemsCsv("   ").error).toMatch(/empty/i);
  });

  it("errors when there are no data rows", () => {
    expect(parseItemsCsv("make,model,serialNumber\n").error).toMatch(/no data/i);
  });

  it("errors when over the row cap", () => {
    const body = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `M,N,S${i}`).join("\n");
    const { error } = parseItemsCsv(`make,model,serialNumber\n${body}\n`);
    expect(error).toMatch(/limit/i);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/modules/items/csv.test.ts`
Expected: FAIL — cannot find module `./csv`.

- [ ] **Step 4: Write the implementation**

```typescript
// src/modules/items/csv.ts
import { parse } from "csv-parse/sync";

export const MAX_IMPORT_ROWS = 2000;

export type RawRow = {
  row: number;
  make: string;
  model: string;
  serialNumber: string;
  homeUnit: string;
  notes: string;
};

// Map a normalized (lowercased, alphanumeric-only) header to a canonical field.
const HEADER_MAP: Record<string, keyof Omit<RawRow, "row">> = {
  make: "make",
  model: "model",
  serialnumber: "serialNumber",
  serial: "serialNumber",
  homeunit: "homeUnit",
  notes: "notes",
};

const normalizeHeader = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

export function parseItemsCsv(text: string): { rows: RawRow[]; error?: string } {
  if (!text.trim()) return { rows: [], error: "The CSV file is empty." };

  let records: Record<string, string>[];
  try {
    records = parse(text, {
      bom: true,
      trim: true,
      skip_empty_lines: true,
      relax_column_count: true,
      columns: (header: string[]) => header.map((h) => HEADER_MAP[normalizeHeader(h)] ?? normalizeHeader(h)),
    });
  } catch {
    return { rows: [], error: "Could not parse the CSV file. Check the format and try again." };
  }

  if (records.length === 0) return { rows: [], error: "The CSV has no data rows." };

  const present = new Set(Object.keys(records[0]));
  const missing = (["make", "model", "serialNumber"] as const).filter((k) => !present.has(k));
  if (missing.length) return { rows: [], error: `Missing required column(s): ${missing.join(", ")}.` };

  if (records.length > MAX_IMPORT_ROWS) {
    return { rows: [], error: `Too many rows (${records.length}). The limit is ${MAX_IMPORT_ROWS} per import.` };
  }

  const rows = records.map((r, i) => ({
    row: i + 1,
    make: r.make ?? "",
    model: r.model ?? "",
    serialNumber: r.serialNumber ?? "",
    homeUnit: r.homeUnit ?? "",
    notes: r.notes ?? "",
  }));
  return { rows };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/modules/items/csv.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/modules/items/csv.ts src/modules/items/csv.test.ts
git commit -m "feat(items): CSV parser with header normalization and row cap"
```

---

## Task 2: Import planner (`import.ts`)

**Files:**
- Create: `src/modules/items/import.ts`, `src/modules/items/import.test.ts`

**Interfaces:**
- Consumes: `RawRow` (Task 1); `newItemSchema`, `NewItemInput` from `./items.schema` (existing: `make/model/serialNumber` required trimmed, `homeUnit/notes` optional, empty → undefined).
- Produces:
  - `type SkippedRow = { row: number; serialNumber: string; reason: string }`
  - `planImport(rows: RawRow[], existingSerials: Set<string>): { toCreate: NewItemInput[]; skipped: SkippedRow[] }`

- [ ] **Step 1: Write the failing test**

```typescript
// src/modules/items/import.test.ts
import { describe, it, expect } from "vitest";
import { planImport } from "./import";
import type { RawRow } from "./csv";

const mk = (row: number, over: Partial<RawRow> = {}): RawRow =>
  ({ row, make: "M4", model: "Carbine", serialNumber: `S${row}`, homeUnit: "", notes: "", ...over });

describe("planImport", () => {
  it("keeps valid, non-duplicate rows", () => {
    const { toCreate, skipped } = planImport([mk(1), mk(2)], new Set());
    expect(toCreate).toHaveLength(2);
    expect(skipped).toHaveLength(0);
    expect(toCreate[0]).toMatchObject({ make: "M4", model: "Carbine", serialNumber: "S1" });
  });

  it("skips a row whose serial already exists in the DB", () => {
    const { toCreate, skipped } = planImport([mk(1, { serialNumber: "A1" })], new Set(["A1"]));
    expect(toCreate).toHaveLength(0);
    expect(skipped).toEqual([{ row: 1, serialNumber: "A1", reason: "already exists" }]);
  });

  it("keeps the first and skips later duplicates within the file", () => {
    const { toCreate, skipped } = planImport(
      [mk(1, { serialNumber: "D1" }), mk(2, { serialNumber: "D1" })],
      new Set()
    );
    expect(toCreate).toHaveLength(1);
    expect(skipped).toEqual([{ row: 2, serialNumber: "D1", reason: "duplicate in file" }]);
  });

  it("skips an invalid row with the validation message", () => {
    const { toCreate, skipped } = planImport([mk(1, { model: "" })], new Set());
    expect(toCreate).toHaveLength(0);
    expect(skipped[0]).toMatchObject({ row: 1, reason: "Model is required" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/items/import.test.ts`
Expected: FAIL — cannot find module `./import`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/modules/items/import.ts
import { newItemSchema, type NewItemInput } from "./items.schema";
import type { RawRow } from "./csv";

export type SkippedRow = { row: number; serialNumber: string; reason: string };

// Pure planning: validate each row, then dedup against the DB and within the
// file (first occurrence wins). Serial comparison is case-sensitive on the
// trimmed value the schema produces.
export function planImport(
  rows: RawRow[],
  existingSerials: Set<string>
): { toCreate: NewItemInput[]; skipped: SkippedRow[] } {
  const toCreate: NewItemInput[] = [];
  const skipped: SkippedRow[] = [];
  const seen = new Set<string>();

  for (const r of rows) {
    const parsed = newItemSchema.safeParse({
      make: r.make,
      model: r.model,
      serialNumber: r.serialNumber,
      homeUnit: r.homeUnit,
      notes: r.notes,
    });
    if (!parsed.success) {
      skipped.push({ row: r.row, serialNumber: r.serialNumber, reason: parsed.error.issues[0]?.message ?? "invalid row" });
      continue;
    }
    const sn = parsed.data.serialNumber;
    if (existingSerials.has(sn)) {
      skipped.push({ row: r.row, serialNumber: sn, reason: "already exists" });
      continue;
    }
    if (seen.has(sn)) {
      skipped.push({ row: r.row, serialNumber: sn, reason: "duplicate in file" });
      continue;
    }
    seen.add(sn);
    toCreate.push(parsed.data);
  }
  return { toCreate, skipped };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/items/import.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/items/import.ts src/modules/items/import.test.ts
git commit -m "feat(items): planImport validates rows and dedups serials"
```

---

## Task 3: `ImportBatch` model + migration

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_import_batch/migration.sql`

**Interfaces:**
- Produces DB model `ImportBatch`; `User.importBatches` relation.

- [ ] **Step 1: Edit `schema.prisma`**

In `model User`, add this relation line alongside the other relations (e.g. after `createdTransfers`):
```prisma
  importBatches    ImportBatch[] @relation("ImportBatches")
```

Append at end of file:
```prisma
model ImportBatch {
  id           String   @id @default(cuid())
  createdBy    User     @relation("ImportBatches", fields: [createdById], references: [id])
  createdById  String
  filename     String
  addedCount   Int
  skippedCount Int
  skipped      Json
  createdAt    DateTime @default(now())

  @@index([createdById])
}
```

- [ ] **Step 2: Generate and apply the migration on the dev DB**

Run: `npx prisma migrate dev --name import_batch`
Expected: creates `prisma/migrations/<ts>_import_batch/migration.sql` containing `CREATE TABLE "ImportBatch"` (+ FK + index), and applies it. This migration is purely additive — no backfill or edits needed.
Run: `npx prisma generate`
Expected: client regenerated with `prisma.importBatch`.

- [ ] **Step 3: Sanity-check the client sees the model**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -5`
Expected: no errors referencing `importBatch` (the type exists). (Other pre-existing output is fine; you're only checking the new model resolves.)

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(db): ImportBatch table for CSV import audit records"
```

> **Do NOT push yet** — `db:deploy` to Supabase happens in the release step (Task 7).

---

## Task 4: `importItems` service

**Files:**
- Modify: `src/modules/items/items.service.ts`
- Create: `src/modules/items/items.service.import.test.ts`

**Interfaces:**
- Consumes: `parseItemsCsv` (Task 1), `planImport`/`SkippedRow` (Task 2), `prisma`.
- Produces:
  - `importItems(text: string, filename: string, createdById: string): Promise<{ added: number; skipped: SkippedRow[]; error?: string }>`

- [ ] **Step 1: Write the failing test** (real test DB, mirroring `items.service.search.test.ts`)

```typescript
// src/modules/items/items.service.import.test.ts
import { beforeAll, beforeEach, expect, test } from "vitest";
import prisma from "@/lib/prisma";
import { resetDb, migrateTestDb } from "../../../tests/helpers/db";
import { createItem, importItems } from "./items.service";

let adminId: string;
beforeAll(() => migrateTestDb());
beforeEach(async () => {
  await resetDb();
  const admin = await prisma.user.create({ data: { name: "Admin", email: "a@x.co", passwordHash: "x", role: "ADMIN" } });
  adminId = admin.id;
});

test("imports valid rows, skips DB duplicates, in-file duplicates, and invalid rows", async () => {
  await createItem({ make: "Dell", model: "5540", serialNumber: "EXIST1", homeUnit: undefined, notes: undefined }, adminId);

  const csv = [
    "make,model,serialNumber,homeUnit,notes",
    "M4,Carbine,NEW1,A Co,tan",   // ok
    "M4,Carbine,EXIST1,,",         // already exists
    "PVS,14,DUP1,,",               // ok (first)
    "PVS,14,DUP1,,",               // duplicate in file
    ",Carbine,BAD1,,",             // invalid (missing make)
  ].join("\n");

  const res = await importItems(csv, "items.csv", adminId);

  expect(res.error).toBeUndefined();
  expect(res.added).toBe(2);
  expect(res.skipped).toHaveLength(3);
  expect(res.skipped.map((s) => s.reason).sort()).toEqual(["already exists", "duplicate in file", "Make is required"].sort());

  // Two new items landed (plus the pre-existing EXIST1 = 3 total).
  expect(await prisma.item.count()).toBe(3);
  const serials = (await prisma.item.findMany({ select: { serialNumber: true } })).map((i) => i.serialNumber).sort();
  expect(serials).toEqual(["DUP1", "EXIST1", "NEW1"]);

  // An audit record was written with the counts and skipped detail.
  const batch = await prisma.importBatch.findFirst();
  expect(batch).toMatchObject({ filename: "items.csv", addedCount: 2, skippedCount: 3, createdById: adminId });
  expect(Array.isArray(batch!.skipped)).toBe(true);
});

test("returns a format error and imports nothing when headers are missing", async () => {
  const res = await importItems("make,model\nM4,Carbine\n", "bad.csv", adminId);
  expect(res.added).toBe(0);
  expect(res.error).toMatch(/serialNumber/);
  expect(await prisma.item.count()).toBe(0);
  expect(await prisma.importBatch.count()).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/items/items.service.import.test.ts`
Expected: FAIL — `importItems` is not exported.

- [ ] **Step 3: Write the implementation** (add to `items.service.ts`)

At the top, extend the Prisma import and add the new imports:
```typescript
import type { Item, ItemStatus, Prisma } from "@prisma/client";
// ...existing imports...
import { parseItemsCsv } from "./csv";
import { planImport, type SkippedRow } from "./import";
```

Append the function:
```typescript
export async function importItems(
  text: string,
  filename: string,
  createdById: string
): Promise<{ added: number; skipped: SkippedRow[]; error?: string }> {
  const { rows, error } = parseItemsCsv(text);
  if (error) return { added: 0, skipped: [], error };

  const existing = new Set(
    (await prisma.item.findMany({ select: { serialNumber: true } })).map((i) => i.serialNumber)
  );
  const { toCreate, skipped } = planImport(rows, existing);

  await prisma.$transaction([
    prisma.item.createMany({ data: toCreate.map((d) => ({ ...d, createdById })) }),
    prisma.importBatch.create({
      data: {
        createdById,
        filename,
        addedCount: toCreate.length,
        skippedCount: skipped.length,
        skipped: skipped as unknown as Prisma.InputJsonValue,
      },
    }),
  ]);

  return { added: toCreate.length, skipped };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/items/items.service.import.test.ts`
Expected: PASS (2 tests). (Test DB already has `ImportBatch` because `migrateTestDb` runs `prisma migrate deploy`, applying Task 3's migration.)

- [ ] **Step 5: Commit**

```bash
git add src/modules/items/items.service.ts src/modules/items/items.service.import.test.ts
git commit -m "feat(items): importItems creates rows and an audit record in one transaction"
```

---

## Task 5: Upload action, page, result UI, entry links

**Files:**
- Modify: `src/app/admin/actions/items.ts`
- Create: `src/app/admin/items/import/page.tsx`, `src/app/admin/items/import/ImportItemsForm.tsx`
- Modify: `src/app/items/page.tsx`, `src/app/admin/items/new/page.tsx`

**Interfaces:**
- Consumes: `importItems` (Task 4), `requireAdmin`, `revalidatePath`.
- Produces:
  - `importItemsAction(prev: unknown, formData: FormData): Promise<{ added: number; skipped: SkippedRow[] } | { error: string }>`

- [ ] **Step 1: Add the server action** (append to `src/app/admin/actions/items.ts`)

```typescript
import { createItem, updateItem, setItemStatus, importItems } from "@/modules/items/items.service";
// (extend the existing items.service import to include importItems)

export async function importItemsAction(_prev: unknown, formData: FormData) {
  const admin = await requireAdmin();
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a CSV file to import." };
  if (!file.name.toLowerCase().endsWith(".csv")) return { error: "The file must be a .csv file." };
  try {
    const text = await file.text();
    const res = await importItems(text, file.name, admin.id);
    if (res.error) return { error: res.error };
    revalidatePath("/items");
    revalidatePath("/admin/audit");
    return { added: res.added, skipped: res.skipped };
  } catch (e) {
    console.error("[importItemsAction] unexpected error:", e);
    return { error: "Something went wrong importing the file. Please try again." };
  }
}
```

- [ ] **Step 2: Write the client form + result UI**

```tsx
// src/app/admin/items/import/ImportItemsForm.tsx
"use client";
import { useActionState } from "react";
import Link from "next/link";
import { importItemsAction } from "@/app/admin/actions/items";

const TEMPLATE = "make,model,serialNumber,homeUnit,notes\n";

function groupSkipped(skipped: { row: number; serialNumber: string; reason: string }[]) {
  const by = new Map<string, string[]>();
  for (const s of skipped) {
    const label = s.serialNumber ? s.serialNumber : `row ${s.row}`;
    by.set(s.reason, [...(by.get(s.reason) ?? []), label]);
  }
  return [...by.entries()];
}

export function ImportItemsForm() {
  const [state, action, pending] = useActionState(importItemsAction, undefined);
  const done = state && "added" in state;

  return (
    <div className="stack">
      <form action={action} className="card stack">
        <div className="field">
          <label className="label" htmlFor="file">CSV file</label>
          <input id="file" className="input" type="file" name="file" accept=".csv" required />
          <p className="subtle">Columns: make, model, serialNumber, homeUnit, notes. First row must be the header.</p>
        </div>
        {state && "error" in state && state.error && <p role="alert" className="alert-error">{state.error}</p>}
        <div className="row">
          <button disabled={pending} type="submit" className="btn btn-primary">{pending ? "Importing…" : "Import CSV"}</button>
          <a className="btn btn-ghost" href={`data:text/csv;charset=utf-8,${encodeURIComponent(TEMPLATE)}`} download="item-import-template.csv">Download template</a>
          <Link href="/items" className="btn btn-ghost">Back to items</Link>
        </div>
      </form>

      {done && (
        <div className="card stack-sm">
          <p className="alert-success">{state.added} item{state.added === 1 ? "" : "s"} added.</p>
          {state.skipped.length > 0 ? (
            <div className="stack-sm">
              <p><strong>{state.skipped.length} skipped:</strong></p>
              <ul>
                {groupSkipped(state.skipped).map(([reason, labels]) => (
                  <li key={reason}>{reason}: {labels.join(", ")}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="subtle">No rows were skipped.</p>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Write the page**

```tsx
// src/app/admin/items/import/page.tsx
import { redirect } from "next/navigation";
import { requireAdmin, AuthError } from "@/lib/authz";
import { ImportItemsForm } from "./ImportItemsForm";

export default async function ImportItemsPage() {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) redirect(e.code === "FORBIDDEN" ? "/" : "/login");
    throw e;
  }
  return (
    <div className="stack">
      <div>
        <h1 className="page-title">Import items</h1>
        <p className="subtle">Bulk-create items from a CSV. Duplicate serial numbers are skipped.</p>
      </div>
      <ImportItemsForm />
    </div>
  );
}
```

- [ ] **Step 4: Add entry links**

In `src/app/items/page.tsx`, next to the existing admin "+ Log new item" link (currently `{isAdmin && <Link href="/admin/items/new" className="btn btn-primary spacer">+ Log new item</Link>}`), add before/after it:
```tsx
          {isAdmin && <Link href="/admin/items/import" className="btn btn-secondary spacer">Import CSV</Link>}
```

In `src/app/admin/items/new/page.tsx`, add an Import link in the header block (after the `<p className="subtle">` line, inside the top `<div>`):
```tsx
        <Link href="/admin/items/import" className="btn btn-ghost btn-sm">Import CSV instead</Link>
```
Add `import Link from "next/link";` at the top of that file.

- [ ] **Step 5: Verify build + lint**

Run: `npm run lint`
Expected: clean.
Run: `npm run build`
Expected: passes (compiles the new action, page, and client form). Allow up to 5 minutes.

- [ ] **Step 6: Manual smoke (optional but recommended)**

Run `npm run dev`, sign in as an admin, go to `/admin/items/import`, upload a small CSV with one new row, one existing serial, and one in-file duplicate. Confirm the result message shows the added count and the grouped skipped list, and the new item appears on `/items`.

- [ ] **Step 7: Commit**

```bash
git add src/app/admin/actions/items.ts src/app/admin/items/import "src/app/items/page.tsx" src/app/admin/items/new/page.tsx
git commit -m "feat(items): admin CSV import page, action, and entry links"
```

---

## Task 6: Audit page "CSV imports" section

**Files:**
- Modify: `src/app/admin/audit/page.tsx`

**Interfaces:**
- Consumes: `prisma.importBatch`, `formatDateTimeHST` (existing).

- [ ] **Step 1: Query import batches and render a section**

In `src/app/admin/audit/page.tsx`, after the `const transfers = await prisma.transfer.findMany(...)` line, add:
```typescript
  const imports = await prisma.importBatch.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { createdBy: { select: { name: true } } },
  });
```

Then, immediately after the opening `<div className="stack">` and the title block, before the existing `<div className="table-wrap">` that lists transfers, insert:
```tsx
      {imports.length > 0 && (
        <div className="stack-sm">
          <h2 className="card__title">CSV imports</h2>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Date</th><th>By</th><th>File</th><th>Added</th><th>Skipped</th></tr>
              </thead>
              <tbody>
                {imports.map((b) => {
                  const skipped = (b.skipped as { serialNumber: string; reason: string }[]) ?? [];
                  return (
                    <tr key={b.id}>
                      <td className="subtle" data-label="Date">{formatDateTimeHST(b.createdAt)}</td>
                      <td data-label="By">{b.createdBy.name}</td>
                      <td data-label="File">{b.filename}</td>
                      <td data-label="Added">{b.addedCount}</td>
                      <td data-label="Skipped">
                        {b.skippedCount}
                        {skipped.length > 0 && <span className="subtle"> ({skipped.map((s) => s.serialNumber || "?").join(", ")})</span>}
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

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: passes; `/admin/audit` compiles with the new section.

- [ ] **Step 3: Commit**

```bash
git add src/app/admin/audit/page.tsx
git commit -m "feat(audit): show CSV import batches on the audit page"
```

---

## Task 7: Verify + release

**Files:** none (verification + deploy).

- [ ] **Step 1: Full verification**

Run: `npm run lint` → clean.
Run: `npx vitest run` → all green (report total).
Run: `npm run build` → passes.

- [ ] **Step 2: Apply the migration to production BEFORE pushing**

```bash
# Apply the ImportBatch migration to Supabase first (prod URLs), then push.
DIRECT_URL="<supabase-5432-url>" DATABASE_URL="<supabase-6543-url>" npm run db:deploy
```
The migration is additive (new table only), so there is no data-loss risk; still apply before pushing so the deployed code's `prisma.importBatch` calls have their table.

- [ ] **Step 3: Push and verify live**

```bash
git push origin feat/hand-receipt-app
```
After the Vercel deploy is Ready, sign in as an admin on the live site, open `/admin/items/import`, import a small CSV, and confirm the result message and the new "CSV imports" row on `/admin/audit`.

---

## Self-Review

**Spec coverage:**
- CSV parse + header normalization + row cap → Task 1. ✔
- Validate + dedup (DB + in-file, first wins) → Task 2 (`planImport`). ✔
- `ImportBatch` model + migration → Task 3. ✔
- Import in one transaction (createMany + audit record) → Task 4. ✔
- Admin upload page + action + result message + entry links + template → Task 5. ✔
- Audit page "CSV imports" section → Task 6. ✔
- Skip-duplicates behavior + reasons ("already exists" / "duplicate in file" / validation message) → Tasks 2, 4, 5. ✔
- Admin-only, generic errors, Prisma-only → Tasks 4, 5 (guardrails). ✔
- Deploy rule (migrate before push) → Task 3 note + Task 7. ✔
- `csv-parse` library → Task 1. ✔

**Placeholder scan:** No TBD/TODO; every code step has concrete code and commands.

**Type consistency:** `RawRow` (Task 1) is consumed by `planImport` (Task 2) and produced by `parseItemsCsv`. `SkippedRow` defined in Task 2 (`import.ts`), re-exported/consumed by `importItems` (Task 4) and rendered in Tasks 5–6 with the same `{ row, serialNumber, reason }` shape. `importItems` signature matches between Task 4 (definition) and Task 5 (action call). `importItemsAction` return shape (`{ added, skipped } | { error }`) matches the client's `"added" in state` / `"error" in state` checks in Task 5.

## Notes
- `resetDb()` TRUNCATEs `Transfer, Item, User` with CASCADE; `ImportBatch` references `User`, so it is cleared by the cascade — no change to `tests/helpers/db.ts` needed.
- `createMany` with an empty `data` array is valid (creates 0 rows) — the all-skipped case still writes an `ImportBatch` with `addedCount: 0`.
