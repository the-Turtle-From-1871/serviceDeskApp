# Marking devices as loaners — design

**Date:** 2026-08-11
**Status:** approved, not yet implemented
**Builds on:** `e84897a` (#119, bulk actions on a scanned batch) and `81a5f46` (#126, bulk rename) — this is the third control in the same "More actions" sheet.
**Surface:** `Item`, the `/items` selection bar, the `/items` table and filter, and `/i/<id>`.

## Problem

The desk keeps a pool of loaner devices — machines handed out temporarily, over and over,
and expected back. **The property book cannot record that.** There is no loaner field
anywhere in the app, and the three columns that look like they could carry one cannot:

- **`deviceCategory`** says what a device *is* (Laptop, Switch). Tagging a laptop "Loaner"
  destroys the real category — and it is an **importable column**, so the nightly Drive
  import overwrites it within a day.
- **`homeUnit` and `storageLocation`** are importable for the same reason. The bulk-actions
  design already refused to offer bulk controls for either, on exactly this ground: *"a
  control that quietly undoes itself is worse than no control."*

So the operator scans a shelf of pool stock, and there is nothing to mark it with.

## Why this is a STORED flag, when readiness and accountability are derived

`CLAUDE.md` is emphatic: *"Readiness AND accountability are DERIVED — neither is a stored
state. Never reintroduce a hand-tickable flag for either."* This design adds a hand-tickable
flag, so the distinction has to be written down or it will be read as a violation.

`Item.isAccountedFor` and `Item.deployableStatus` were dropped because they were **stored
answers to questions the data already knew**. Readiness is computable from four live signals;
a column beside them could only drift, and it did — 0 of 1,139 rows ever carried a value.

Loaner-ness is the opposite kind of fact. **Nothing in the data can infer it.** No signal
distinguishes a laptop kept for lending from an identical laptop issued permanently; the
difference is a standing decision by the property manager, and the only source of truth for
it is a person. A derived loaner status would have nothing to derive from. There is no
second derivation to drift against, and the flag changes only when someone says so.

The test to apply to the next flag someone proposes: *could this be computed from signals the
app already stores?* For readiness, yes — so store nothing. For loaner, no — so store it.

## Non-goals

These are **deliberately deferred to their own cycles**, both agreed with the requester:

- **Pre-filling a hand receipt's return timer for a loaner.** Real and wanted, but the
  receipt's `dueAt` is per-*transfer* while this flag is per-*item*, so a mixed batch raises a
  question this spec should not answer in passing.
- **A separate loaner bucket in the dashboard fleet analytics.** Touches the readiness SQL
  and its parity test; worth its own review.

Also out of scope, with reasons:

- **Excluding loaners from the dormant-device list** — explicitly declined by the requester.
- **A CSV `isLoaner` column.** Making it importable is precisely what this design exists to
  avoid. If the pool ever needs seeding in bulk from a spreadsheet, that is a deliberate
  decision about which side wins, not a convenience to add now.
- **Per-item editing on `/i/<id>` or the admin edit form.** See *Rejected alternatives*.

## What changes, from the operator's side

- Scan or select a batch on `/items`, open **More actions**, and tap **Mark as loaner** —
  or **Remove loaner mark** to take devices back out of the pool.
- A **Loaner** badge appears on the item's page and on its `/items` row.
- **Sort & filter** gains a *Loaners only* checkbox, so the whole pool is one tap away.
- The nightly import never touches the mark.

## Architecture

### 1. `Item.isLoaner` — a new boolean column

```prisma
isLoaner  Boolean  @default(false)
```

with `@@index([isLoaner])`, matching how `deviceUIC` and `deviceCategory` are indexed: a
low-cardinality equality filter feeding a paginated list. (At 1,200 rows the planner may well
seq-scan it anyway; the index is for consistency with the documented rule — *index every hot
`where` column* — and for the fleet's growth, not for today's numbers.)

**`@default(false)`, not nullable.** Every existing device is not a loaner, which is a
complete and correct answer — a NULL third state would mean "nobody has said", and no part of
this feature wants to distinguish that from "no".

**The importer never writes it.** `commitImport` builds `ItemUpdate.data` from a *named*
column set derived from the CSV row (`import.ts`), so a column absent from that mapping is
untouched by every one of the three import front doors. That property is the entire reason
this is a new column rather than a reused one, and it is worth a test.

### 2. `setItemsLoaner` — one batched write

`src/modules/items/items.service.ts`, modelled directly on `markItemsReady`:

```ts
setItemsLoaner(itemIds: string[], isLoaner: boolean): Promise<{ updated: number; skipped: number }>
```

One `updateMany`, never a loop. Dedupes ids, no-ops on empty, throws `ItemError("TOO_MANY")`
above `MAX_BULK_ITEMS`, and **enforces no permissions** — the calling action owns the gate.

**Retired items are excluded and reported, never refused** — the cross-cutting rule for every
bulk action here. A device that has left the fleet cannot be pool stock, and one retired row
must not fail a batch of fifty. `skipped` is `ids.length - updated`.

Note that `skipped` therefore also counts rows that were **already in the requested state**,
because `updateMany` reports rows *matched and written*. That is a real wrinkle in the
reported number and the reason the scope filters on `status` only: adding
`isLoaner: !isLoaner` to the `where` would make the count exact but would silently reclassify
"already a loaner" as "skipped (retired or not applicable)", which reads as a failure. The
sheet's existing `outcome()` wording covers it; the count is "rows this action did not write",
not "rows that went wrong".

### 3. `setItemsLoanerAction` — the gate

`src/app/admin/actions/items.ts`, beside `markItemsReadyAction` and the two rename actions:

| | |
| --- | --- |
| Guard | `requireCapability("MANAGE_ITEMS")` — item vocabulary, the same capability the rename and category actions use |
| Input | `itemIds` (comma-joined) and `isLoaner` (`"1"` / `"0"`) |
| Returns | `{ error: string } \| { ok: true; updated: number; skipped: number; isLoaner: boolean }`, annotated not inferred |
| Revalidates | `/items` only |

The batch is client-supplied ids, so this guard is the whole boundary. Revalidation stays
list-level — `setReadinessAction` sets that precedent, and revalidating up to 500 individual
`/i/<id>` paths is the thing it exists to avoid. The item page picks the badge up on its next
render.

`/admin/analytics` is deliberately **not** revalidated: nothing on the dashboard reads the
flag yet. That changes when the analytics bucket ships, and the entry must be added then.

### 4. The sheet gains a loaner pair, inside the existing MANAGE_ITEMS group

`BulkActionsMenu` already gates a `MANAGE_ITEMS` group behind a prop named `canRename`,
because rename was the only control in it. It now gates two unrelated controls, so **the prop
is renamed `canManageItems`** — in the component, its one mount site in `ItemSelectTable`, and
`BulkActionsMenu.test.tsx`. Keeping the name would leave the next reader guessing why a loaner
button is hidden by a rename flag.

Two buttons — *Mark as loaner* and *Remove loaner mark* — sharing one message line, in the
same shape the queue's Flag/Complete pair already uses: they are two ends of one job, never
used together, and the bar is sticky over the table where every line of height hides a row.
Two `useTransition`s, not one, so a slow write cannot point the busy state at the wrong button.

**No confirm step.** The audit control confirms because it writes accountability records that
cannot be undone; this writes one reversible boolean, and the inverse button is sitting beside
it.

### 5. Seeing it: a badge and a column

**On `/i/<id>`**, a `Loaner` badge beside the existing `StatusBadge`.

**On `/items` desktop**, a new hideable `Loaner` column in `ITEM_COLUMNS`, rendering the badge
or the em-dash placeholder. It is **not sortable** — it joins the documented list of columns
the server cannot order by, since a two-value sort is a filter wearing the wrong control.

**On the mobile card, the badge goes beside the device name in `.cell-primary` — NOT into the
More panel.** That panel is at **seven** fields, and `ui-styling.md` records the measurement:
an eighth "would put the tab's foot into the panel's SECOND row; measure before adding one,
and treat that as the point where the tab needs its own anchor rather than the row's centre."
A badge costs the card no panel row and reads where the Retired flag already does.

`.badge-loaner` is a new class in `globals.css` beside the other badge colours. Two standing
rules apply: `--muted` is a **surface** tint and renders at 1.08:1 as text, and neither
`next build` nor jsdom has a layout engine — the colour must be contrast-checked in a real
browser.

### 6. Filtering: a one-way toggle, in both query paths

`?loaner=1`, surfaced through `SortFilterMenu`'s existing **`MenuToggle`** — the same control
`needsRename` uses. A `MenuFilter` select is wrong here for the reason that type's own comment
gives: unchecked means *no filter*, never *show me the complement*, and "devices that are not
loaners" is not a list anyone wants.

**The filter must be added to BOTH query paths.** `listItems` runs a Prisma `where` normally
and a raw-SQL twin (`itemFilterSql`) whenever the sort involves a derived key, and
`items.readiness-sort.parity.test.ts` fails if they disagree — for a real reason: the two
would otherwise return different rows depending only on which column happens to be sorted.

Three more places carry it or silently drop it:

- **`ItemsPage`** echoes `loaner` back, as it does `uic` and `needsRename`.
- **`/items/page.tsx`** reads `?loaner` through `firstParam`, exactly `=== "1"`. A permissive
  check would make `?loaner=0` mean the opposite of what it says.
- **`ItemsSearchInput`** rebuilds the whole `/items` URL from scratch on every keystroke, and
  its own comment names this as the trap: *"Anything missing here is silently dropped the
  moment someone types in the search box — that is how the UIC filter and the secondary sort
  key both used to disappear."* It needs the value, a ref, and the `params.set`.

## Rejected alternatives

- **A `deviceCategory` value.** The obvious move and the reason the request read as
  impossible: it destroys the real category and the nightly import reverts it.
- **A `LoanerPool` table with its own rows.** A join for a boolean. It would buy per-device
  pool metadata (added-on, pool name) that nobody asked for, and cost a join on the hottest
  list query in the app.
- **Deriving it from receipt history** — "a device issued more than N times is a loaner".
  Tempting because it needs no column, and wrong: it would classify a much-repaired laptop as
  pool stock and a brand-new loaner as not one, and the operator could not correct it.
- **Adding `isLoaner` to `editableItemFields`.** That set is eight text fields feeding two
  edit surfaces through `z.object()`. A boolean there walks straight into the trap
  `CLAUDE.md` says has already shipped twice: **an unchecked checkbox sends nothing in
  `FormData`**, so unticking the box would strip to `undefined` and the form would report
  "Saved" while leaving the flag set. Making it safe needs a hidden companion input or
  presence-checking, on a shared field set that two forms build from — for a control the
  bulk sheet already provides, since selecting one row on `/items` is exactly the
  single-item case. Deferred deliberately; if per-item editing is wanted later it should get
  its own action, as `itemIdentitySchema` did.
- **A nullable `Boolean?`.** A third "nobody has said" state nothing in this feature reads.

## Error handling

| Case | Behaviour |
| --- | --- |
| Empty selection | Zod refuses with *"Select at least one item."* Nothing written. |
| Over 500 selected | `ItemError("TOO_MANY")` → a readable message naming the cap. |
| Some items retired | Excluded by the `status: "ACTIVE"` scope, counted in `skipped`, reported in the outcome line. |
| Some items deleted meanwhile | Not matched by the id-scoped `where`; folded into `skipped`. |
| Already in the requested state | Written again harmlessly (idempotent), counted in `updated`. |
| Caller lacks `MANAGE_ITEMS` | `AuthError("FORBIDDEN")` from the action's first line. The UI also hides the group, but that is presentation, not the boundary. |
| A nightly import runs over a marked device | The flag is untouched — it is not in the import's column set. |
| `?loaner` is anything but `1` | Treated as absent. No filter. |
| The write fails | Generic message to the client, real error logged server-side. |

## Testing

**DB — `src/modules/items/items.loaner.test.ts`**
- Sets the flag on a batch and clears it again; `{ updated, skipped }` is right both ways.
- A retired row is excluded and counted in `skipped`; its `isLoaner` is unchanged.
- Over `MAX_BULK_ITEMS` throws `TOO_MANY`; an empty list is a no-op.
- **An import over a marked device leaves `isLoaner` true.** This is the load-bearing
  property of the whole design and the one a future refactor of the import could break
  silently. It belongs beside the import tests as well as here.

**Action**
- Refuses a caller without `MANAGE_ITEMS`, mirroring the existing bulk-action tests.
- Rejects an empty `itemIds`.

**Query**
- `listItems({ loaner: true })` returns only marked rows, and `loaner` is echoed back.
- **Parity**: the filter behaves identically when the sort forces the raw-SQL path.
  `items.readiness-sort.parity.test.ts` is the existing guard and must cover the new filter.

**jsdom**
- The loaner controls render only when `canManageItems` is set.
- The `[popover]` element still carries no class — the invariant `BulkActionsMenu.test.tsx`
  already pins.

**Not provable here.** jsdom has no layout engine: the badge's contrast, the new column, and
the card at 390px all need a real browser. Check that the `.cell-primary` badge has not
shifted the swipe tab's hit box, using `elementFromPoint` at the tab's top, centre and bottom
— the measurement `ui-styling.md` requires whenever the card grows.

## Documentation, in the same commit

- **`CHANGELOG.md`** — an `Added` entry, plus a **Notes** subsection naming the migration
  (any new column does).
- **`docs/SECURITY.md`** — `setItemsLoanerAction` is a new capability-gated write over
  client-supplied ids, which is exactly what #126 recorded for the two rename actions. Gate,
  bound, and the retired-exclusion. Bump *Last reviewed*.
- **`.claude/rules/backend-constraints.md`** — the flag, why it is stored rather than derived,
  and that the importer must never learn to write it.
- **`CLAUDE.md`** — one line under *Backend Architecture & Feature Constraints*, next to the
  derived-readiness rule, so a reader who never opens the rule file still meets the
  distinction. The derived-readiness bullet itself needs the caveat, or the two read as
  contradictory.

## Migration

One additive migration: a nullable-free boolean with a default and an index. No backfill —
the default is the correct value for all 1,200 existing rows.

- Authored with `prisma migrate diff --from-config-datasource --to-schema` and applied
  locally with `migrate deploy`. `prisma migrate dev` cannot run non-interactively in this
  environment.
- **Migrate-before-push.** `next build` never runs `migrate deploy`, so the column must exist
  in Supabase *before* the merge deploys — Prisma enumerates every column in its SELECT, so
  until then **every item read fails**, not just the new control.

## Risks

- **The parity twin.** A filter added to one query path and not the other changes which rows a
  page shows based only on the chosen sort. The existing parity test is the guard; it must be
  extended, not assumed.
- **`ItemsSearchInput` silently drops URL state it does not know about.** Two filters have
  already been lost this way. Typing in the search box is the reproduction.
- **The mobile card is at its measured ceiling.** A badge is cheaper than a panel row, but the
  swipe tab's hit box is centred on the row and moves as the card grows. Measure, do not
  assume.
- **`skipped` counts more than failures.** Rows already in the requested state land in
  `updated`, but rows the `where` misses for any reason are reported with the same
  "retired or not applicable" wording. Acceptable, and named here so the next reader does not
  read the number as an error count.
- **Nothing stops a future CSV column being added for `isLoaner`.** The protection is a
  documented decision and a test, not a mechanism.
