# Design: Mass item import (CSV)

**Date:** 2026-07-08
**Status:** Approved (design), pending implementation plan

## Problem

Admins can only add items one at a time via `/admin/items/new`. They need to
**bulk-import items from a CSV** with all item fields, creating them together,
while **skipping duplicate serial numbers** and recording the import in the
audit log.

## Decisions (locked with the user)

1. **Behavior:** import every valid, non-duplicate row; **skip duplicates**
   (don't error the whole file); then show a message listing which serials were
   skipped and why.
2. **Duplicate check:** a serial is a duplicate if it **already exists in the
   `Item` table** OR it **repeats within the uploaded file** (first occurrence
   kept, later ones skipped).
3. **Audit:** record each import as an `ImportBatch` row, surfaced in a new
   "CSV imports" section on the `/admin/audit` page.
4. **CSV parsing:** use the vetted `csv-parse` library (v7, MIT — validated via
   `npm view`).
5. `Item.serialNumber` stays **non-unique at the DB level**; dedup is an
   application-level check (existing data may contain duplicates, so a DB unique
   constraint is out of scope and would risk the migration).

## Current system (baseline)

- `Item { make, model, serialNumber, homeUnit?, notes?, status, createdById }`;
  `serialNumber` is NOT unique in the DB.
- `newItemSchema` (Zod): `make`/`model`/`serialNumber` required (trimmed,
  min 1); `homeUnit`/`notes` optional. Used by the single-item form.
- `createItem(input, createdById)` → `prisma.item.create`.
- Admin gate: `requireAdmin()` in every admin action + the `/admin` layout.
- The `/admin/audit` page currently just lists all `Transfer` rows — there is
  no generic audit-event table.
- No CSV library installed.

## Data model

```prisma
model ImportBatch {
  id           String   @id @default(cuid())
  createdBy    User     @relation("ImportBatches", fields: [createdById], references: [id])
  createdById  String
  filename     String
  addedCount   Int
  skippedCount Int
  skipped      Json     // [{ row: number, serialNumber: string, reason: string }]
  createdAt    DateTime @default(now())

  @@index([createdById])
}
```
- Add the inverse relation `importBatches ImportBatch[]` to `User` under a
  named relation `"ImportBatches"`.
- **Migration:** additive only (create `ImportBatch` table); no data backfill.
  Must `db:deploy` to Supabase before pushing (standing deploy rule).

## CSV format

- **Header row required.** Column names matched **case-insensitively** and
  **order-independent**: `make, model, serialNumber, homeUnit, notes`.
  (Accept a `serial` / `serial number` alias for `serialNumber` for
  convenience — normalize header keys by lowercasing and stripping non-alphanumerics.)
- Required per row: `make`, `model`, `serialNumber`. Optional: `homeUnit`, `notes`.
- Unknown extra columns are ignored.
- **Row cap:** 2,000 data rows. Over that → the import is rejected with a clear
  message (no partial import).
- Parsed with `csv-parse/sync`: `{ columns: <normalized header mapper>, trim: true, skip_empty_lines: true, relax_column_count: true }`.

## Modules & flow

### `src/modules/items/csv.ts` (pure)
- `NORMALIZE_HEADER(name): string` — lowercase, strip non-alphanumerics
  (`"Serial Number"` → `serialnumber`).
- `parseItemsCsv(text: string): { rows: RawRow[]; error?: string }` — wraps
  `csv-parse/sync`, maps normalized headers to canonical field names
  (`make/model/serialNumber/homeUnit/notes`), returns row objects (1-based
  `row` index for reporting). Surfaces a parse error string (malformed CSV,
  missing required header, empty file, over row cap) instead of throwing.

### `src/modules/items/import.ts` (pure planning, no DB)
- `type SkippedRow = { row: number; serialNumber: string; reason: string }`
- `planImport(rows: RawRow[], existingSerials: Set<string>): { toCreate: NewItemInput[]; skipped: SkippedRow[] }`
  - For each row (in order): validate via `newItemSchema`.
    - Invalid → `skipped` with reason (first Zod issue message, e.g. "Model is required").
    - Valid but serial in `existingSerials` → `skipped` reason `"already exists"`.
    - Valid but serial already seen in this file → `skipped` reason `"duplicate in file"`.
    - Otherwise → `toCreate`, and add its serial to the seen set.
  - Serial comparison is case-sensitive on the trimmed value (matches how the
    single-item form stores it). (Document this; do not silently lowercase.)

### `src/modules/items/items.service.ts` → `importItems`
```
importItems(text: string, filename: string, createdById: string):
  Promise<{ added: number; skipped: SkippedRow[]; error?: string }>
```
1. `parseItemsCsv(text)` → rows (or return `{ added: 0, skipped: [], error }`).
2. Load existing serials: `prisma.item.findMany({ select: { serialNumber: true } })`
   → `Set`.
3. `planImport(rows, existing)`.
4. `prisma.$transaction([ createMany(toCreate + createdById), importBatch.create(...) ])`
   — items and the audit record commit together. `createMany` with
   `skipDuplicates` not relied upon (no DB unique constraint); dedup already
   done in `planImport`.
5. Return `{ added: toCreate.length, skipped }`.

## Server action + UI

- **`src/app/admin/items/import/page.tsx`** — admin page: `<form>` with a
  `type="file" accept=".csv"` input, an "Import" button, a short format hint
  (`make, model, serialNumber, homeUnit, notes`), and a "Download template"
  link (a tiny static CSV header the browser downloads).
- **`importItemsAction`** in `src/app/admin/actions/items.ts` (`"use server"`):
  `requireAdmin()`; read the uploaded `File` from `FormData` (`await file.text()`);
  reject if missing/empty/not `.csv`; call `importItems(text, file.name, admin.id)`;
  `revalidatePath("/items")` and `revalidatePath("/admin/audit")`; return the result.
- **Result UI** (client component using `useActionState`): on success show
  *"N items added."* and, if any, a grouped skipped list:
  *"3 skipped — already exists: A1, C3; duplicate in file: B2; invalid: (row 9) Model is required."*
  Generic error message on unexpected failure; detail logged server-side.
- **Entry points:** add an **"Import CSV"** link next to "+ Log new item" on
  `/items` (admin only) and on the New Item page.

## Audit page

- `/admin/audit`: add a **"CSV imports"** section above the existing hand-receipt
  table. Query `prisma.importBatch.findMany({ orderBy: { createdAt: "desc" }, take: 50, include: { createdBy: { select: { name: true } } } })`.
  Render per row: date (HST), admin name, filename, `addedCount` added /
  `skippedCount` skipped, and the skipped serials (from `skipped` JSON). The
  existing transfer table is unchanged.

## Error handling

- Parse/format problems (bad CSV, missing header, empty, over cap) → returned as
  a single `error` string; nothing imported.
- Per-row problems (invalid fields, duplicate serials) → never fail the batch;
  collected in `skipped` and reported.
- Unexpected exceptions in the action → generic client message, `console.error`
  server-side (existing guardrail).
- Admin-only throughout (`requireAdmin` + `/admin` layout).

## Testing

- **Unit `csv.ts`:** header normalization; quoted fields with embedded commas
  (Notes), escaped `""` quotes, CRLF/LF, blank lines skipped; missing-header
  error; empty-file error; over-cap error.
- **Unit `import.ts`:** valid rows → `toCreate`; invalid row → skipped with
  reason; serial in `existingSerials` → skipped "already exists"; repeated serial
  in file → first kept, second skipped "duplicate in file"; ordering/row numbers
  correct.
- **Service:** `importItems` with mocked prisma — existing-serials query, the
  `createMany` payload (with `createdById`), the `ImportBatch` record written in
  the same `$transaction`, returned counts.
- **Action:** admin guard; empty/non-CSV file rejected; row-cap rejected.

## Out of scope

- DB-level unique constraint on `serialNumber`.
- Updating existing items from the CSV (upsert) — import only creates.
- Column mapping UI / arbitrary delimiters — fixed header names, comma-delimited.
- Background/streaming processing for very large files (bounded at 2,000 rows).
