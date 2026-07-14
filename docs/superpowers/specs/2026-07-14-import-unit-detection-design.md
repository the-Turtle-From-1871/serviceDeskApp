# Auto-detect home unit from device name on mass import

**Date:** 2026-07-14
**Status:** Approved design, pending implementation plan

## Problem

On mass item import, the `homeUnit` column is optional and usually left blank.
The unit is already encoded in the `deviceName` (e.g. `HI-DCSIM-LT-001`), so users
retype information the system could derive. We want to auto-detect `homeUnit` from
`deviceName`, and — for device names whose unit code we don't yet recognize — let the
user teach the system the mapping once, so it applies to the rest of that import and to
every future import.

## Goals

- Auto-fill `homeUnit` from `deviceName` during import when `homeUnit` is blank.
- Store the expanded **full unit name** in `homeUnit` (e.g. `487FA BATTERY A`).
- Let users resolve unrecognized device names interactively and persist what they teach.
- Do not change behavior for rows that already carry an explicit `homeUnit`.

## Non-goals

- No standalone units-management (CRUD) screen. The `Unit` table is populated by the
  seed and grows via import-time learning only. A future admin UI is out of scope.
- No change to the item schema beyond what already exists (`deviceName`, `homeUnit`).

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Where the abbreviation lives in `deviceName` | A delimited **segment** (split on `-` and `_`), matched in **any** position |
| Override rule | Only fill `homeUnit` when the CSV value is **blank**; explicit values are preserved |
| Stored value | The unit's **full name** |
| Mapping storage | A **`Unit` database table** (abbreviation → full name) |
| Unmatched names | **Prompt** the user: pick which segment is the code + type the full name; persist it |
| Flow | **Two-phase**: upload → resolve → confirm. Nothing written until confirm |
| Abbreviation keying for unmatched | User **picks the segment** and types the full name |
| Blank/unresolved at confirm | Row still imports with an **empty `homeUnit`**; nothing learned |
| `CSMS2` source typo | **Fixed** to `Combined Support Maint Shop 2` |
| Resolve list overflow | **Scrollable** (bounded by the existing 2000-row import cap) |

## Data model

New Prisma model:

```prisma
model Unit {
  id           String   @id @default(cuid())
  abbreviation String   @unique   // stored UPPERCASE, e.g. "DCSIM", "487B", "CSMS2"
  fullName     String             // e.g. "487FA BATTERY A"
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
}
```

Requires a new migration `add_unit_table`. Per the project deploy rule (migrate before
push), the migration is generated and flagged before any push.

## Seed data

- Commit the abbreviation list as `prisma/units.data.ts` — an array of
  `{ abbreviation, fullName }` transcribed from `hiarng_unit_abbreviations.csv`
  (70 entries), with `CSMS2` corrected to `Combined Support Maint Shop 2`.
- `prisma/seed.ts` upserts every entry (idempotent, keyed on `abbreviation`).
- Fix a latent bug in `seed.ts`: it early-returns when the admin already exists, which
  would skip unit seeding. Reorder so units seed **first, always**, then the admin block
  (its missing-env guard unchanged).

## Detection logic (pure)

New `src/modules/items/unit-detect.ts`:

```ts
export function splitSegments(deviceName: string): string[]; // split on [-_], trim, drop empties
export function detectHomeUnit(
  deviceName: string,
  unitsByAbbrev: Map<string, string>, // key = UPPERCASE abbreviation, value = fullName
): string | undefined;
```

- `detectHomeUnit` uppercases each segment and returns the `fullName` of the **first**
  segment present in the map; `undefined` if none match.
- `splitSegments` is shared with the analyze phase so the UI shows the same tokenization.

## Import planning

`src/modules/items/import.ts` — `planImport` gains a units-map parameter and an extra
return field:

```ts
planImport(
  rows: RawRow[],
  existingSerials: Set<string>,
  unitsByAbbrev: Map<string, string>,
): {
  toCreate: NewItemInput[];
  skipped: SkippedRow[];
  unresolved: { row: number; deviceName: string; segments: string[] }[];
};
```

Per validated row: if `homeUnit` is blank, run `detectHomeUnit`. If it resolves, set it.
If it does not, add the row to `unresolved` (with segments) and leave `homeUnit` empty.
Rows with an explicit `homeUnit` are untouched and never appear in `unresolved`.

## Units service

New `src/modules/items/units.service.ts`:

```ts
export function loadUnitMap(): Promise<Map<string, string>>; // UPPERCASE abbrev -> fullName
export function learnUnits(
  resolutions: { abbreviation: string; fullName: string }[],
): Promise<void>; // upsert each by UPPERCASE abbreviation
```

`learnUnits` validates with a Zod schema: `abbreviation` trimmed, non-empty,
`^[A-Za-z0-9]+$`; `fullName` trimmed, non-empty. Abbreviations are uppercased before
upsert.

## Server actions (two-phase)

`src/app/admin/actions/items.ts` replaces the single import action with two thin
actions. Each performs `auth()` + admin authorization first, extracts the file/resolutions
from `FormData`, delegates to a service function in `items.service.ts`, and returns
generic error strings while logging details server-side. The business logic lives in the
service (`analyzeImport(text)` and `commitImport(text, resolutions, createdById)`) so it
is unit-testable without the action layer:

1. **`analyzeImportAction(file)`** → `analyzeImport`: parse CSV, `loadUnitMap`,
   `planImport`. Returns `{ counts: { toImport, skipped, autoDetected }, skipped,
   unresolved }` or `{ error }`. Writes nothing.
2. **`commitImportAction(file, resolutions)`** → `commitImport`: validate `resolutions`,
   `learnUnits` (upsert), then re-parse + reload map + `planImport`, and in one
   `$transaction` `createMany` items + create the `ImportBatch`. Returns
   `{ added, skipped, detected }`.

The client re-submits the same file in phase 2 (server stays stateless). Because commit
reloads the unit map *after* `learnUnits`, a unit taught for one row is auto-applied to
every other blank row sharing that segment — no per-row wiring.

## UI (`ImportItemsForm.tsx`)

Two-phase client component; the chosen `File` is held in React state across phases.

- **Phase 1:** file input + "Analyze" button → calls `analyzeImportAction`.
- **Resolve step:** for each `unresolved` entry, render the segments as radio buttons
  (choose the unit code) and a full-name text input. As a segment is resolved, collapse
  any other unresolved entries containing that same (uppercased) segment — each new unit
  is filled once. The list is scrollable.
- **Confirm:** "Import" button → `commitImportAction` with the file + collected
  resolutions. Unresolved-and-left-blank entries import with empty `homeUnit`.
- **Result:** existing added/skipped summary, plus "N home units auto-detected" and
  "M new units learned".
- Update helper text: `homeUnit` is optional and auto-detected from `deviceName`.

## Error handling

- Actions catch exceptions, return generic client messages, log stack traces server-side.
- Invalid resolutions (bad abbreviation/full name) fail Zod validation in
  `commitImportAction` → generic error, no partial writes (upserts + import share intent;
  learning happens before the item transaction, and is itself idempotent).

## Testing

- `unit-detect.test.ts`: any-segment match, first-match-wins, case-insensitive, no match,
  blank/edge input; `splitSegments` tokenization.
- `import.test.ts` (extend): blank→detected, explicit `homeUnit` preserved, undetected →
  `unresolved` with segments; update existing callers for the new signature.
- `units.service` test: `learnUnits` upserts and uppercases; rejects invalid input.
- Integration test: analyze → learn a new unit → commit, asserting the item is stored
  with the learned full name and the `Unit` row persists.

## Files touched

- `prisma/schema.prisma` (add `Unit`)
- `prisma/migrations/<ts>_add_unit_table/` (new)
- `prisma/units.data.ts` (new)
- `prisma/seed.ts` (seed units; fix early-return)
- `src/modules/items/unit-detect.ts` (new)
- `src/modules/items/units.service.ts` (new)
- `src/modules/items/import.ts` (signature + unresolved)
- `src/modules/items/items.service.ts` (analyze/commit paths, load map, counts)
- `src/app/admin/actions/items.ts` (two actions)
- `src/app/admin/items/import/ImportItemsForm.tsx` (two-phase UI)
- Tests as above
