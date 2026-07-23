# CSV Import — Update-on-Match + New MDM Telemetry Fields

**Date:** 2026-07-23
**Status:** Approved (design)
**Area:** Admin bulk item import (`/admin/items/import`)

## Problem

Today the CSV item importer treats every row whose `serialNumber` already exists
as a duplicate and **skips** it (`reason: "already exists"`). Admins re-importing
an MDM/asset export can't use it to refresh a device's `deviceName` or assigned
user, and there is no way to carry MDM telemetry (last logon, enrollment,
compliance) into the catalog at all.

## Goals

1. On a serial match, **update** the item's changed tracked fields instead of
   skipping it — but never re-create it and never mark it a plain "duplicate".
2. Add an importable **assigned user** field (maps to the item's
   `currentUserEmail`).
3. Add four new importable MDM telemetry fields:
   `lastLogonUserPrincipalName`, `lastLogonDate`, `enrollmentDate`, `compliance`.
4. Relax the required-field rule so partial rows import (identity permitting).
5. Header matching is case-, space-, and order-insensitive (already true — extend
   the map only).

## Non-goals

- No date parsing/typing — the two date fields are stored as plain text exactly
  as provided.
- No re-run of `homeUnit` auto-detection on **updates** (only on creates, as today).
- No editing of the new telemetry fields from the UI (import-only, read-only display).
- No change to the accepted public-enumerability tradeoff for `/i/*`.

## Matching & field rules

### Identity
`serialNumber` remains the sole identity and match key, compared
case-insensitively (citext), exactly as today.

### Required fields (new-vs-existing aware — enforced in `planImport`)
- **New serial (create):** `make`, `model`, `serialNumber` all required.
  Row is skipped/reported if any is blank. `deviceName` and everything else
  optional (blank stored as blank/null).
- **Existing serial (update):** only `serialNumber` required. `make`/`model`/
  `deviceName` optional and never overwritten.
- **Blank serial:** always skipped, reported `"serial number is required"`.

The row Zod schema hard-requires only `serialNumber`; the make/model-for-new
rule lives in `planImport`, which alone knows whether the serial already exists.
`newItemSchema` (manual "New Item" form) is unchanged and still requires
make/model/deviceName.

### Tracked fields (update-on-match)
On a serial match, a row is an **update** if any tracked field's provided,
non-blank value differs from what's stored. Blank/absent cell = "not provided" =
leave stored value untouched (uses the `""`→`undefined` optional semantics).

| Field                        | Maps to             | On change      |
|------------------------------|---------------------|----------------|
| `deviceName`                 | `deviceName`        | **logged** to `ItemEdit` |
| `assignedUser`               | `currentUserEmail`  | **logged** to `ItemEdit` |
| `lastLogonUserPrincipalName` | (new column)        | silent         |
| `lastLogonDate`              | (new column)        | silent         |
| `enrollmentDate`             | (new column)        | silent         |
| `compliance`                 | (new column)        | silent         |

- `make`, `model`, `homeUnit`, `notes` are **never** overwritten on a match.
- If a matched serial's `make` or `model` differs from stored, the row still
  updates its tracked fields and is flagged with a **make/model mismatch warning**
  in the report (make/model identify the physical device and are not changed).

### Buckets
Each row resolves to exactly one of:
- **create** — new serial, make/model present → `createMany`
- **update** — existing serial, ≥1 tracked field differs
- **unchanged** — existing serial, nothing differs (reported, not an error)
- **skipped** — invalid (blank serial; new row missing make/model) or duplicate
  in file (first occurrence wins)

`"already exists"` disappears as a skip reason.

## Data model

New migration (`2026-07-23`), all additive:

- `Item.lastLogonUserPrincipalName String?`
- `Item.lastLogonDate String?`
- `Item.enrollmentDate String?`
- `Item.compliance String?`
- `ImportBatch.updatedCount Int @default(0)`

`make`/`model` stay `NOT NULL` (no code path writes a blank one, so nullability
is unnecessary). No index needed — none of the new columns back a hot
`where`/`orderBy`.

Applied via the project's two-step flow (`prisma migrate diff --script` →
`migrate deploy`; prod hand-applied per the standard manual-apply process),
because interactive `migrate dev` can't run in this shell.

## Components & data flow

### `csv.ts` (parse)
- Add to `RawRow`: `assignedUser`, `lastLogonUserPrincipalName`, `lastLogonDate`,
  `enrollmentDate`, `compliance` (all `string`, default `""`).
- Add header-map entries (normalized, lowercased-alphanumeric keys):
  `assigneduser`, `lastlogonuserprincipalname`, `lastlogondate`,
  `enrollmentdate`, `compliance`. Matching is already order- and
  case/space/punctuation-insensitive via `normalizeHeader`.
- **Column presence:** require only `serialNumber` as a present column. `make`,
  `model`, `deviceName` no longer required columns (their per-row requirement is
  now handled in `planImport`).

### `items.schema.ts`
- New `importRowSchema`: `serialNumber` required (`min(1)`); `make`, `model`,
  `deviceName`, `homeUnit`, `notes`, `assignedUser`, and the four telemetry
  fields all optional (`""`→`undefined`). Used only by the importer.
- `newItemSchema` unchanged.

### `item-diff.ts`
- Extend `ItemLoggedFields` (the diffable set) with the four telemetry keys so
  `diffItemFields` can compute their changes. The import computes **two** diffs
  against a matched item: a *logged* subset (`deviceName`, `currentUserEmail`)
  and a *silent* subset (the four telemetry keys). `diffItemFields` already
  ignores keys absent from `after`, so passing two different `after` subsets
  yields the two change lists.

### `import.ts` (`planImport`, pure)
- New signature: caller passes `existingBySerial: Map<lowerSerial, {id, make,
  model, deviceName, currentUserEmail}>` instead of a serial `Set`.
- Returns `{ toCreate, toUpdate, unchanged, skipped, unresolved, detected }`.
- `toUpdate` entry: `{ itemId, serialNumber, loggedChanges: FieldChange[],
  silentChanges: FieldChange[], makeModelMismatch: boolean }`.
- `unchanged` entry: `{ row, serialNumber, makeModelMismatch }`.
- Per row: parse with `importRowSchema`; blank serial → skip; in-file dedup by
  serial (first wins); look up match:
  - **match:** compute logged + silent diffs; set `makeModelMismatch` if
    make/model provided and differ; if any change → `toUpdate`, else `unchanged`.
  - **no match (new):** require make & model non-blank, else skip
    (`"make and model are required for new items"`); run `homeUnit`
    auto-detection as today; push to `toCreate`.

### `items.service.ts`
- `analyzeImport` / `commitImport`: one `findMany` selecting `{id, serialNumber,
  make, model, deviceName, currentUserEmail}` (bounded — whole table today, same
  as current serial-only fetch), keyed into `existingBySerial`.
- `analyzeImport` returns counts `{ toCreate, toUpdate, unchanged, skipped,
  autoDetected }` + `skipped`, `unresolved`, and a `mismatches` summary.
- `commitImport(text, filename, resolutions, editor)` — now takes an `editor
  {id, name}` (was `createdById`) to stamp `ItemEdit`. In one transaction:
  1. `createMany(toCreate, { skipDuplicates: true })` (race-safe backstop, as today).
  2. For each `toUpdate`: `tx.item.update({ where:{id}, data: {...logged,
     ...silent} })`; if `loggedChanges.length > 0`, also
     `tx.itemEdit.create({ changes: loggedChanges, editedById, editedByName })`.
     Before-values come from `planImport` — **no per-row SELECT** (respects the
     no-query-in-loop rule; distinct-value writes are unavoidably individual and
     bounded by the 2000-row import cap).
  3. `importBatch.create({ addedCount, updatedCount, skippedCount, skipped })`.
- Returns `{ added, updated, skipped, unchanged, detected, mismatches }`.

### `admin/actions/items.ts`
- `commitImportAction` passes `{ id: admin.id, name: admin.name }` as editor.
- Thread the new counts/mismatches to the client; `revalidatePath("/items")`
  and `/admin/audit` as today.

### `ImportItemsForm.tsx`
- `TEMPLATE` header gains the new columns; help text lists them and notes
  serial is the only required column (make/model required only for new items).
- Analyze preview: "**X** to add · **Y** to update · **Z** unchanged · **W**
  skipped", plus a make/model-mismatch warning list.
- Done screen: "X added, Y updated", with skipped + mismatch breakdown.
- Update the `Analysis`/result TS types.

### `i/[itemId]/page.tsx` + `ItemDetailsCard.tsx`
- Render the four telemetry fields read-only, **only for an authenticated
  session** (server-side check). Not shown in the logged-out/PIN-gated public
  view — `lastLogonUserPrincipalName` is a user email and CLAUDE.md requires the
  public surface stay PII-minimal; this is not a widening of it.

## Error handling

- Parse/format errors return a generic client message (as today); details logged
  server-side.
- The whole commit stays in one `$transaction` — a mid-import failure rolls back
  creates, updates, edits, and the batch record together.
- Per-row problems never throw: they land in `skipped`/`mismatches` and are
  reported.

## Testing

- **`import.test.ts` (`planImport` units):** match + different deviceName →
  update (logged); match + different assignedUser → update (logged); match +
  different telemetry only → update (silent, no logged change); match, all equal
  → unchanged; match + make/model differ → mismatch flag; new row missing
  make/model → skipped; blank serial → skipped; blank assignedUser on a match →
  no change to that field.
- **`csv.test.ts`:** the new headers map in any column order and any case; only
  `serialNumber` is a required column.
- **`items.service.import.test.ts` (integration):** `commitImport` updates an
  existing item's `deviceName` + `currentUserEmail` + telemetry, writes exactly
  one `ItemEdit` (logged fields only), bumps `updatedCount`, creates no new row;
  telemetry-only change writes no `ItemEdit`. Update the existing test whose
  `EXIST1` row now lands in **unchanged** (make/model differ, deviceName same →
  mismatch-flagged unchanged), not skipped.
- **Item detail page:** telemetry block renders for a logged-in session and is
  absent when logged out. (jsdom is not layout proof; presence/gating only.)

## Docs

Same-commit updates: `CHANGELOG.md` (Added: telemetry fields + update-on-match;
Changed: import required-field rules; Notes: migration + new columns),
`CLAUDE.md` import/data-model notes if any rule text is contradicted, and the
`ImportItemsForm` help text.
