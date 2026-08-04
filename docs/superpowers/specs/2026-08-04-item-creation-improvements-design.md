# Item creation: suggestions, delete, and the confirmation screen

**Date:** 2026-08-04
**Status:** Approved, not yet implemented
**Verified against:** `main` at `087f65c`

## Problem

Three unrelated gaps around logging a device into inventory:

1. **Typing a make, model or unit is unassisted, and the assistance that does
   exist is invisible on a phone.** Four surfaces edit item fields — the
   creation form, the admin edit form, the item detail card, and the identity
   form — and between them the `<datalist>` coverage is arbitrary: Category has
   one on three of them, Home unit on two, UIC and Make/Model on none. Worse,
   `<datalist>` does not render on mobile browsers at all, and the technicians
   who log devices work from phones. So the assistance is missing where it
   exists and invisible where it does not. The result is the drift this app
   spends real effort preventing elsewhere: `Dell` and `DELL`, `Latitude 5420`
   and `Latitude5420`, one unit spelled two ways.
2. **A wrong row cannot be removed.** Retire is the only lifecycle control. A
   duplicate created by a fat-fingered serial, or a row imported from a bad CSV,
   stays in the property book forever as a retired ghost that still appears in
   counts and searches.
3. **After creating an item there is no way to reach it.** The confirmation
   screen offers "Add another" and "Back to items" — so the one thing an admin
   most often wants next, opening the device they just logged to add notes or
   print a label, takes a search.

## Goal

Suggestions that work identically on phone and desktop, on every catalogue field
of every surface that edits one; an admin-only permanent delete with an explicit
confirmation; and a route from the confirmation screen straight to the new item.

## Non-goals

- **No new vocabulary tables.** Make, Model and UIC stay free-text columns with
  no managed list. Category and Unit keep the managed lists they already have.
- **No change to what the form accepts.** Every field stays free text; a value
  that is not in the suggestions is still submittable. The CSV importer can
  introduce a category the property book has never seen, so the form must never
  be stricter than the importer.
- **No delete for non-admins**, and no bulk delete.
- **No change to Retire.** Delete sits beside it; neither replaces the other.
- **No change to which fields each role may edit.** Suggestions are added to
  fields that are already editable on each surface; the `USER`-editable set stays
  exactly two fields, and make/model/serial stay confined to the identity form.
- **No suggestions on user or contact forms.** `NewUserForm` and
  `ContactBookSection` also use `<datalist>`; they are outside this change.

---

## 1. `SuggestCombobox` — one component, five fields

New file: `src/components/SuggestCombobox.tsx`.

It is deliberately modelled on `ContactCombobox` — same `.input` field, same
`.card` dropdown positioned `absolute` beneath it, same `role="combobox"` /
`role="listbox"` / `aria-activedescendant` wiring, same ArrowUp/ArrowDown/Enter/
Escape handling, same `--surface-2` highlight, same `onMouseDown` preventDefault
so a click lands before the input's blur closes the list, and the same
`aria-live` status line. A user who has met the contact picker on the receipt
builder should recognise this immediately.

### 1.1 Why it does not fetch

`ContactCombobox` queries the server on every keystroke because the contact book
is PII and unbounded — shipping it to the client would be a disclosure, and
`searchContactsAction` exists to prevent that.

Neither is true here. These are five short vocabularies of public catalogue
values. Measured on the dev database: **16 makes, 53 models, 52 home units**,
plus roughly **44 UICs** and a handful of categories in production — about 170
strings, none longer than 55 characters, well under 4 KB in total.

So the options arrive as a `string[]` prop and the component filters the array it
already holds. That removes the debounce, the request-race guard and the
server round-trip, and suggestions appear on the first keystroke with no lag.

> The dev database's UIC and category counts (4 and 5) are artefacts of
> `db:seed:analytics`, which overwrites both columns. Production is the ~44
> figure. Either way the list is bounded and small; the cap in §1.3 is the
> guard, not the current row count.

### 1.2 Props

```ts
{
  id?: string;
  name: string;            // the posted field name — the input IS the field
  options: string[];       // the vocabulary, already resolved server-side
  defaultValue?: string;
  required?: boolean;      // ContactCombobox hardcodes required; this one asks
  maxVisible?: number;     // default 8
}
```

The component is **uncontrolled** — it owns its own text state and posts through
its own `name`, so the new-item form does not need to become a controlled form to
adopt it. (`ContactCombobox` is controlled because its consumer,
`ReceiptBuilderForm`, has to write several other fields when a contact is
picked. Nothing here does.)

### 1.3 Filtering

Case-insensitive substring match on the trimmed query, preserving the order the
options arrived in, capped at `maxVisible` (8). An empty query shows the first
`maxVisible` options on focus — that is what makes the control useful to
someone who does not yet know what the vocabulary contains, which is the whole
problem on a field like Category.

An exact case-insensitive match still lists (it is a legitimate re-selection),
but the list closes on pick.

### 1.4 Mobile

This is the reason the component exists. A `<ul>` beneath an `<input>` renders
identically on iOS Safari, Android Chrome and desktop, where `<datalist>` does
not. Options carry a `min-height` of `var(--tap)` (44px), the documented floor
for this app — a 6px-padded `<li>` is a ~22px tap target on a phone.

The dropdown is `position: absolute` inside a `position: relative` wrapper, as
in `ContactCombobox`, so it overlays the fields below rather than reflowing the
form as the list grows and shrinks.

### 1.5 Where the options come from

The managed vocabulary where one exists; observed values where one does not.

| Field | Source | Already exists? |
|---|---|---|
| `deviceCategory` | `listCategoryNames()` | yes |
| `homeUnit` | `listUnits()` → `fullName` | yes |
| `make` | `listItemFieldSuggestions()` | **new** |
| `model` | `listItemFieldSuggestions()` | **new** |
| `deviceUIC` | `listItemFieldSuggestions()` | **new** |

Category and Home unit deliberately keep their vocabulary sources rather than
switching to `DISTINCT Item`. Sourcing them from observed values would resurrect
strings an admin deliberately deleted from the managed list — and worse, would
make the picker disagree with `/admin/categories` and `/admin/units`, which are
the screens that exist to curate exactly these values.

### 1.6 `listItemFieldSuggestions()`

New export in `src/modules/items/items.service.ts`. **One** query, not three —
a `$queryRaw` with three `UNION ALL` arms, each grouping one column, discarding
`NULL` and blank, ordering by frequency descending then value ascending, and
capping per field:

```
field | value
------+---------------
make  | Dell
make  | HP
model | Latitude 5420
uic   | WPME10
```

Returns `{ make: string[]; model: string[]; deviceUIC: string[] }`.

Frequency ordering is the point of doing it in SQL: the makes an admin actually
logs float to the top of an 8-row list instead of being alphabetised behind a
one-off. The per-field cap is `200`, far above the real distinct counts — it
exists so a future import of dirty data cannot turn this into an unbounded
payload, per the data-fetching rule in `CLAUDE.md`.

The three arms are one round trip and a fixed cost; this is not a query per
field and must not become one.

### 1.7 Wiring into the form

`NewItemForm.tsx` currently maps a `fields` array of `[name, label, required]`
tuples to plain `<input>`s, with two `<datalist>`s appended. After this change
all five catalogue fields render a `SuggestCombobox` and **both `<datalist>`
elements are deleted** — leaving them would mean two suggestion mechanisms on
one field, one of which is invisible on the device the form is used on.

`serialNumber`, `deviceName` and `notes` keep their existing plain inputs.
`serialNumber` is an identity, not a vocabulary; suggesting one would be
actively wrong.

`page.tsx` gains `listItemFieldSuggestions()` to its existing
`Promise.all([listCategoryNames(), listUnits()])`.

### 1.8 The other three surfaces

The same component replaces every remaining `<datalist>` on an item field, and
fills the gaps where no suggestion existed at all. Today's coverage is uneven in
a way that has no design behind it — it is simply where someone happened to add
a `list=` attribute:

| Surface | Home unit | UIC | Category | Make / Model |
|---|---|---|---|---|
| `NewItemForm` | datalist | — | datalist | — |
| `EditItemForm` (`/admin/items/<id>/edit`) | — | — | datalist | n/a |
| `ItemDetailsCard` (`/i/<id>`) | datalist | — | datalist | n/a |
| `EditItemIdentityForm` | n/a | n/a | n/a | — |

After this change every cell that is not `n/a` is a `SuggestCombobox`. Three
consequences worth stating:

- **`EditItemForm` and `ItemDetailsCard` gain Home unit and UIC suggestions they
  never had.** On the edit form that means `page.tsx` must now fetch
  `listUnits()` as well — it currently fetches only `listCategoryNames()`.
- **`EditItemIdentityForm` gains Make and Model.** `serialNumber` stays a plain
  input, for the same reason it does on the creation form: it is an identity,
  not a vocabulary, and suggesting one would be actively wrong. This form is
  deliberately friction-ful because correcting a serial rewrites what existing
  signed receipts appear to describe — suggestions do not reduce that friction,
  they only make the make/model corrections beside it consistent.
- **`n/a` means the field is not on that form**, not that it was overlooked.
  `editableItemFields` is exactly seven fields and does not include
  make/model/serial; those live only in the identity form. That separation is
  load-bearing and this change does not touch it.

The three fields a `USER` can reach (`currentUserEmail`, `currentPosition`, and
nothing else) get **no** suggestions. `currentUserEmail` holds free text like
`"SGT Smith"` on badly-imported rows and is not an email-validated field;
`currentPosition` is prose. Neither is a vocabulary.

### 1.9 Non-admins must not receive the vocabularies

`/i/<id>` is a **public** page (behind the shared PIN for logged-out visitors,
but not behind a login). It already guards its vocabulary fetches:

```ts
isAdmin ? listCategoryNames() : []
```

Every new suggestion source must follow that pattern — `listUnits()` and
`listItemFieldSuggestions()` are fetched on that page **only when `isAdmin`**.
The fields they feed are admin-only, so a non-admin should neither pay for the
query nor receive the catalogue. This is not a change to what the page exposes;
it is the existing guard applied to new data, and skipping it would widen the
public surface by accident.

---

## 2. Delete

### 2.1 The schema change

`TransferItem.itemId` becomes nullable with `onDelete: SetNull`:

```prisma
model TransferItem {
  item           Item?        @relation(fields: [itemId], references: [id], onDelete: SetNull)
  itemId         String?
  serialNumber   String
  ...
}
```

Today it is `ON DELETE RESTRICT`, so Postgres refuses to delete any item that
has ever appeared on a hand receipt — which is most of them.

**Detaching the row rather than deleting it is what keeps receipts whole.** Two
properties of the existing code make this safe, and both were verified rather
than assumed:

- `getTransferByReceiptNumber` includes `lines → items` and **never joins
  `Item`**. The receipt page and the DA 2062 render `TransferItem.serialNumber`
  and `TransferLine.make` / `.model`, all snapshots written when the receipt was
  created. A deleted item changes nothing about what the document says.
- `processReturn` selects on `transferItemId`, the row's own primary key — not
  on `itemId`. A detached row is still returnable, so a receipt cannot become
  un-closable because someone deleted a device.

What is lost is the backlink from item to receipts (`listReceiptsForItem`,
`getHoldingTransfer`), which query `items: { some: { itemId } }`. A `NULL`
simply never matches — and the item no longer exists to ask the question from.

Migration: `<timestamp>_transfer_item_nullable_item`. Authored with
`prisma migrate diff --from-config-datasource --to-schema` and applied with
`migrate deploy`; `migrate dev` cannot run non-interactively in this
environment. It must be applied to production **before** the merge deploys, per
the migrate-before-push rule.

### 2.2 Service

`deleteItem(id: string): Promise<void>` in `items.service.ts` — a single
`prisma.item.delete({ where: { id } })`. No transaction and no manual cleanup:
`ServiceQueueItem`, `ItemEdit` and `ItemAudit` already cascade, and after §2.1
`TransferItem` detaches. A missing row surfaces as Prisma `P2025`.

No `ItemEdit` history row is written. The item it would belong to is being
deleted, and its edit history is cascading away with it.

### 2.3 Action

`deleteItemAction(formData)` in `src/app/admin/actions/items.ts`:

- `await requireAdmin()` first, as every action in this file does.
- `P2025` (already deleted — a double submit, or two admins on the same row)
  returns a specific, calm message rather than an error.
- Any other failure logs the stack server-side and returns
  `"Something went wrong deleting this item. Please try again."`
- `revalidatePath("/items")`.

### 2.4 UI

New `src/components/DeleteItemButton.tsx`, rendered beside Retire in
`ItemSelectTable`'s row actions, behind the existing `isAdmin` guard. Offered
for **ACTIVE and RETIRED alike** — a retired row is the most likely thing an
admin wants to delete.

The confirmation is a native `<dialog>`, not a shadcn `Dialog`:

- There is no Dialog primitive in `src/components/ui/` today, so this would mean
  adding one.
- `/items` is on the original `globals.css` design system. `CLAUDE.md` is
  explicit that existing pages are not to be rewritten to Tailwind as a
  drive-by.
- Because Tailwind preflight is deliberately not imported, a new shadcn
  primitive has to re-supply what preflight normally provides — `border-solid`
  on every border width, `appearance-none` on buttons, the 44px tap floor. A
  native `<dialog>` styled with the ledger classes already in use avoids that
  class of bug entirely.

Dialog content names the item so the admin can see what they are about to
destroy — make, model, serial — and states two things plainly: the deletion is
permanent and cannot be undone, and existing hand receipts keep their record of
this device. The second sentence matters; without it a careful admin will assume
deleting an item damages the receipts it appears on, and will not use the
feature.

Buttons: **Delete permanently** (`btn-danger`) and **Cancel** (`btn-ghost`).
Escape closes it, as `<dialog>` does natively. No type-the-serial-to-confirm
step — that is a friction tax for a control an admin reaches deliberately,
already sitting behind an explicit dialog.

---

## 3. The confirmation screen

`NewItemForm`'s success branch gains **"Open this item"** → `/i/<itemId>` as the
primary action, ahead of "Add another" and "Back to items". `state.itemId` is
already returned by `createItemAction`; only the link is missing.

The from-search path changes. Today, when the form was opened from the `/items`
empty state, `createItemAction` redirects to the filtered list and the
confirmation screen never renders — so the new choice would be missing on
exactly the path where items are created fastest. That redirect is removed; both
paths now return the same confirmation, and when the form came from a search the
screen carries a fourth link back to it.

**The redirect's logic moves; it is not discarded.** The existing `redirect()`
builds its destination carefully, and every part of that reasoning still
applies to a link:

- The target is **derived, never caller-supplied** — the path is hardcoded and
  `q` is read back off the row Prisma just wrote, so there is no redirect target
  for anyone to craft. A link built from a client-posted value would give that
  property away.
- `URLSearchParams` does the encoding. Concatenating mangles a serial containing
  `&`, `#`, `+` or a space and lands the admin on an empty list for the item
  they just created.
- `uic` is carried back **only when the new item actually satisfies it**, since
  `listItems` filters `deviceUIC` by exact equality — returning with a filter the
  item does not match would hide the very row the link exists to show.

So `createItemAction` returns `{ itemId, searchHref? }`, with `searchHref` built
by the same code that builds the redirect today and present only when
`fromSearch` was set. The form renders it; it never constructs it.

Result — one screen, one behaviour to learn:

| Action | Target | Shown |
|---|---|---|
| Open this item | `/i/<itemId>` | always |
| Add another | `/admin/items/new` | always |
| Back to items | `/items` | always |
| Back to search | `state.searchHref` — `/items?q=<serial>[&uic=…]` | only when `fromSearch` |

The `fromSearch` / `returnUic` hidden inputs stay as they are — read off
`formData` rather than the parsed result, because `newItemSchema` is a
`z.object()` and strips unknown keys.

---

## 4. Files touched

| File | Change |
|---|---|
| `src/components/SuggestCombobox.tsx` | **new** — the shared picker |
| `src/components/SuggestCombobox.test.tsx` | **new** — filtering + keyboard |
| `src/components/DeleteItemButton.tsx` | **new** — button + `<dialog>` |
| `src/app/admin/items/new/NewItemForm.tsx` | five comboboxes; datalists removed; confirmation screen |
| `src/app/admin/items/new/page.tsx` | fetch the three new vocabularies |
| `src/app/admin/items/[itemId]/edit/EditItemForm.tsx` | three comboboxes; datalist removed |
| `src/app/admin/items/[itemId]/edit/EditItemIdentityForm.tsx` | make + model comboboxes |
| `src/app/admin/items/[itemId]/edit/page.tsx` | add `listUnits()` + `listItemFieldSuggestions()` |
| `src/app/i/[itemId]/ItemDetailsCard.tsx` | three comboboxes; both datalists removed |
| `src/app/i/[itemId]/page.tsx` | UIC suggestions, **admin-only** like the existing fetches |
| `src/app/admin/actions/items.ts` | `deleteItemAction`; drop the from-search redirect |
| `src/components/ItemSelectTable.tsx` | Delete beside Retire |
| `src/modules/items/items.service.ts` | `listItemFieldSuggestions`, `deleteItem` |
| `prisma/schema.prisma` + migration | `TransferItem.itemId` nullable, `SetNull` |

No `<datalist>` remains on any item field after this change. The two remaining
uses in the repo — `NewUserForm.tsx` and `ContactBookSection.tsx` — are user and
contact fields, not item fields, and are out of scope.

## 5. Testing

**Integration (Vitest, real Postgres):**

- `deleteItem` removes the item; its `ItemEdit` / `ItemAudit` /
  `ServiceQueueItem` rows go with it.
- **The receipt-survival test is the important one.** Create a receipt over an
  item, delete the item, then assert the `TransferItem` row still exists with
  `itemId === null` and `serialNumber` unchanged, and that
  `getTransferByReceiptNumber` still returns the line with its serial, make and
  model. This is the claim the whole design rests on.
- A return still processes against a detached row.
- `listItemFieldSuggestions` returns distinct non-blank values, frequency-first,
  capped.
- `deleteItemAction` rejects a non-admin.

**Component (`npm run test:ui`, jsdom):** filtering, empty-query-on-focus,
arrow-key navigation, Enter picking the highlighted option, Enter submitting
freely typed text when nothing is highlighted, Escape dropping the highlight.

**Real browser, mobile viewport:** `npm run build` and jsdom have no layout
engine and are not evidence for any of this. The suggestion list overlaying
rather than reflowing, the 44px tap targets, and the `<dialog>` on a phone must
be seen in a real browser — on **all four** surfaces, since they sit in
different layouts (a form grid, a card inside the public item page, and a
compact identity card) and the absolutely-positioned dropdown can overflow
differently in each.

**Non-admin check:** load `/i/<id>` signed out and as a `USER` and confirm the
page ships no unit, UIC, make or model vocabulary — the fields are admin-only
and the fetches are guarded on `isAdmin`.

## 6. Documentation

Per the project rule, in the same commit as the code:

- **`CHANGELOG.md`** — under `## 2026-08-04`: `Added` entries for the
  suggestions, the permanent delete, and the "open this item" choice; a
  `Changed` entry for the from-search path no longer redirecting. A **Notes**
  subsection for the migration and its migrate-before-merge requirement.
- **`README.md`** — the item-registry bullet gains suggestions (on every item
  edit surface, working on mobile) and delete.
- **`docs/ARCHITECTURE.md`** — the `TransferItem` description in Supporting
  models gains the nullable `itemId` and *why* detaching is safe; the Item
  section gains delete alongside retire.
- **`docs/SECURITY.md`** — a new admin-only destructive capability, the fact
  that deleting an item does **not** delete receipt evidence, and a note that
  the item page's suggestion vocabularies stay behind its existing `isAdmin`
  guard so the public surface does not widen.
- **`scripts/check-security-docs.mjs`** — add
  `src/app/admin/actions/items.ts` to the watch list. It is not currently
  watched and is about to carry a permanent-delete action; the sibling
  `admin/actions/readiness.ts` is watched for a strictly weaker reason.

## 7. Risks

- **The migration is the only irreversible-ish step.** Widening a column to
  nullable is safe and backward-compatible — existing rows keep their values and
  existing code reading `itemId` as non-null still gets a string for every row
  written before the change. Prisma's generated type becomes `string | null`,
  so any consumer that assumed non-null fails at compile time rather than at
  runtime. The narrowing back is what would be lossy, so this is a one-way door
  in practice.
- **Delete is genuinely permanent.** There is no soft-delete and no undo. That
  is the requested behaviour; Retire remains the reversible option and the
  dialog says which is which.
- **Suggestions are a snapshot per page load.** An item created in another tab
  will not appear in this tab's list until reload. Acceptable: the fields are
  free text, so a missing suggestion costs nothing but typing.
