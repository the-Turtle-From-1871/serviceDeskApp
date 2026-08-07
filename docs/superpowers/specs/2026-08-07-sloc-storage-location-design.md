# Storage location (SLoc) — design

**Date:** 2026-08-07
**Status:** Approved, ready for an implementation plan

## Problem

The property book records what a device is, whose it is, and who currently
holds it — but not **where it physically sits when nobody holds it**. The
fleet export the desk already works from carries that value in a column called
`SLoc` (storage location). Today that column is unrecognised by the importer
and silently dropped, so the information exists in the spreadsheet and nowhere
in the app.

## Scope

Add one new field to `Item`, importable from the existing CSV import, editable
by admins, displayed on the item page, and matchable from the `/items` search
box.

**Out of scope:** reading `.xlsx` workbooks directly. The importer is CSV-only
(`parseItemsCsv` over `csv-parse`, `<input accept=".csv">`), and the file the
desk uploads is an Excel sheet saved as CSV. Native workbook parsing is a
separate feature — a new dependency, its own sheet/cell-type handling, and it
would change the importer for every column rather than this one.

## Decisions

| Question | Decision |
|---|---|
| File format | A CSV column, exported from Excel. No `.xlsx` parsing. |
| Value model | Free text with suggestions, like `deviceUIC`. No managed vocabulary. |
| Who can edit | Admins only. |
| Item page visibility | Signed-in staff only — a row in the existing details card. |
| `/items` list | Searchable via `?q=`. **No** column, **no** sort key. |

### Why free text and not a managed list

`deviceCategory` and `homeUnit` are managed vocabularies with an admin screen,
a delete-refused-while-in-use guard and learn-on-import. That machinery exists
because those two values group the fleet in analytics and filters, so drift
between an item's stored string and the vocabulary row is a real defect.

Storage location has no such consumer. It is a lookup value read one item at a
time, and an unrecognised SLoc arriving in a CSV must never fail a row. A plain
free-text column with a suggestion combobox — the `deviceUIC` shape, minus its
index (see below) — carries the whole requirement at roughly a third of the work. If real values
turn out messy across 1,200 items, promoting it to a managed list later is an
additive change.

## Data model

```prisma
storageLocation String?
```

Nullable plain text on `Item`.

**No `@map`.** The physical column name must equal the field name, because the
raw-SQL half of the `/items` filter names physical columns directly.
`currentUserEmail @map("currentUser")` is the standing example of why that
distinction bites.

**Naming.** The field is `storageLocation` in code and **"Storage location
(SLoc)"** in the UI. Repo convention is descriptive field names
(`lastLogonUserPrincipalName`, `currentUserEmail`); `SLoc` is the fleet
export's jargon and belongs in the CSV header alias list, which is where it
does real work.

**No index, deliberately.** The field joins `deviceName` / `make` / `model` in
the search's `ILIKE '%q%'` branch, and none of those three is indexed either —
only `serialNumber` carries a `pg_trgm` GIN, because it backs the public
per-keystroke serial search. Adding a trigram index for this one column and not
its three siblings would be arbitrary at ~1,200 rows, where the query is
already a sequential scan. Revisit if the fleet grows an order of magnitude, or
if the `/items` search becomes per-keystroke.

**Migration.** Authored with `prisma migrate diff --from-config-datasource
--to-schema --script` followed by `migrate deploy` — `migrate dev` cannot run
non-interactively in this shell. Applied to Supabase **before** the merge
deploys, per migrate-before-push.

## CSV import

`RawRow` and `importRowSchema` each gain `storageLocation`, typed with the
existing `optional` helper: a blank or absent cell becomes `undefined`, which
`diffItemFields` reads as "not submitted" and leaves the stored value
untouched. Clearing a location requires the item's edit form, exactly as it
does for every other imported field.

### Header aliases

Accepted: `sloc`, `storagelocation`, `storageloc`.

`normalizeHeader` lowercases and strips non-alphanumerics, so `SLoc`, `S_Loc`,
`S Loc`, `Storage Location` and `storageLocation` all resolve to the same key.

**A bare `location` alias is deliberately excluded.** Same reasoning as the
bare `type` alias that is already banned for `deviceCategory`: it is generic
enough that a fleet or MDM export could carry a "Location" column meaning a
geographic site, building or country. Aliasing it would overwrite every matched
device's storage location in one import and log that churn to `ItemEdit`
history. Keep the alias list explicit.

### Behaviour on a matched row

A row whose serial already exists **overwrites** the stored storage location,
matching how `deviceName`, `deviceUIC`, `deviceCategory`, `homeUnit` and the
assigned user already behave on a match. The value routes through `loggedAfter`
in `planImport`, so:

- the change lands in `ItemEdit` history like a hand edit, and
- it inherits the existing rule that a `RETIRED` item is updated but writes no
  history row.

`ItemEdit.changes` is a `Json` column holding `[{field, from, to}]`, so a new
logged field needs no enum and no second migration. `ItemLoggedFields` in
`item-diff.ts` gains the key.

## Edit surfaces

Added to **`editableItemFields`** in `items.schema.ts` — the single field
definition both admin surfaces build from — so `/admin/items/<id>/edit` and the
item detail card gain it together and cannot drift. Typed `clearable`, so
emptying the input records a clear-to-null rather than reporting "Saved" while
silently no-opping.

`userItemDetailsSchema` is **untouched**: a standard `USER` still edits exactly
two fields (holder email, current position). This is an admin-only field, and
the role split is enforced server-side by `updateItemDetailsAction` picking the
schema by role.

Also added to `NewItemForm` and `newItemSchema`, so an item created by hand can
carry a location from the start. Every rendered field must be declared in the
schema — `z.object()` strips undeclared keys, which has shipped as a silent
"Saved" bug twice.

`listItemFieldSuggestions` gains a fourth `UNION ALL` arm so the combobox
offers locations already in use. It stays one query.

## Display

**Item page (`/i/<id>`)** — one more row in `ItemDetailsCard`'s `<dl>`,
alongside Device UIC and Category, plus an admin-only input in that card's edit
form.

**The public surface does not change.** `ItemDetailsCard` already renders
inside `{loggedIn && …}` (`page.tsx:107`), so the whole details list is
staff-only today; a logged-out visitor sees only the make/model heading,
`Serial … · home unit`, the status badge, the overdue-audit banner and receipt
history. Storage location joins the gated list, so no unauthenticated visitor
ever receives it — not in the rendered page and not in the RSC Flight payload,
since the component is not rendered at all without a session.

This was originally scoped as "visible to everyone" on the assumption that the
details list was public. It is not, and un-gating it to honour that reading
would have published storage locations on a surface that currently carries only
make, model, serial, home unit and status. Staff-only was chosen once the code
was checked.

Unlike `notes`, the value needs **no `isAdmin` gate on the prop**: it is
readable by any signed-in user and only its *editing* is admin-restricted.

**`/items` list** — no column and no sort key. `sort-keys.ts`,
`items-view.ts` and the mobile card layout are untouched.

## Search

The `?q=` filter is implemented **twice** — a Prisma `where` and a raw-SQL
twin — because a sort involving a derived key (`readiness`, `auditState`) has
to go down a `$queryRaw` path. Both must change in the same commit:

- Prisma: `{ storageLocation: { contains: search, mode: "insensitive" } }`
  added to the `OR`.
- Raw: `OR i."storageLocation" ILIKE ${pattern}::text` added to
  `itemFilterSql`, as a bound parameter, never interpolated.

The value is bound in both paths. `items.readiness-sort.parity.test.ts` seeds
real rows and asserts the two paths return the same ids in the same order for
the same filters — a new case matching **only** on storage location is what
catches a future change made to one path and not the other.

Note the `/items` search is behind the login gate, so this does not widen the
public search (`liveSearchAction`), which stays serial- and receipt-only.

## Testing

| File | What it pins |
|---|---|
| `csv.test.ts` *(append)* | `sloc` / `S_Loc` / `Storage Location` all map to `storageLocation`; a bare `location` header does **not**. |
| `item-diff.test.ts` | A changed storage location produces a `FieldChange`; an unchanged one produces none. |
| `items.schema.test.ts` | Import blank → `undefined` (leave alone); form blank → clear recorded. |
| `import.test.ts` | Create sets it; a matched row overwrites it; blank leaves it untouched; a `RETIRED` match writes no history row. |
| `items.readiness-sort.parity.test.ts` | A search matching only on storage location returns identical ids from both the Prisma and raw paths. |

The alias map is precisely the kind of table that breaks silently — an
unrecognised header is ignored, so a regression reports a *successful* import
with the column quietly dropped. That is how the `DeviceOwnershipUIC` bug
reached production and left ~1,000 items with an empty UIC.

**`csv.test.ts` already exists** — 121 lines, 15 tests, dating to the original
import feature — and its existing cases guard that exact regression plus the
category aliases, the bare-`type` exclusion, quoting, and five error paths. The
new cases are **appended**. (An earlier draft of this document claimed the file
had no coverage. That was wrong: it came from reading a code-intelligence
"no covering tests" result for a single *symbol* as a statement about the
*file*. The claim reached the plan, the plan told an implementer to "create"
the file, and 10 tests were deleted before review caught it.)

## Documentation (same commit)

- **`CHANGELOG.md`** — entry under `## 2026-08-07`, Added.
- **The import page's on-screen column list** (`ImportItemsForm.tsx`) — the
  new column and its accepted aliases.
- **`CLAUDE.md`** — the header-alias note, including why a bare `location` is
  excluded, alongside the existing `type` exclusion.
- **`docs/SECURITY.md`** — **not required.** Nothing in this change touches
  authn/authz, crypto, retention, or the public unauthenticated surface: the
  field is visible only to signed-in users, editable only by admins through the
  existing role-picked schema split, and searchable only from the login-gated
  `/items` page. No file on the `scripts/check-security-docs.mjs` watch list is
  modified, so the `Security docs current` CI job will not fire. Run
  `npm run check:security-docs` to confirm rather than assuming.

## Risks

1. **The two search paths drift.** Mitigated by the parity test, which is
   extended as part of this work rather than after it.
2. **A future export carries a generic "Location" column.** Mitigated by
   refusing that alias and writing down why.
3. **The importer's SQL allowlist is missed.** `UPDATABLE_ITEM_COLUMNS` in
   `items.service.ts` guards the batched UPDATE's identifier interpolation. A
   new importable column absent from it makes `planImport` emit a field the
   writer then refuses, so every import carrying an SLoc fails with "Refusing
   to update unknown column(s)".

   **Mitigated by a test in `items.service.import.test.ts`, NOT `import.test.ts`.**
   This distinction is the whole point: `import.test.ts` exercises `planImport`,
   which is pure and never reaches the allowlist, so a storage-location test
   there passes whether or not the allowlist entry exists. Only
   `items.service.import.test.ts` calls `commitImport` against a real database
   and therefore runs the batched UPDATE. An earlier draft of this document
   claimed the risk was "covered by the import test that asserts a matched row's
   location is overwritten" — that was wrong, and it named the test that cannot
   catch it. The same trap applies to `homeUnit`, whose real coverage also lives
   in the service-level file.
