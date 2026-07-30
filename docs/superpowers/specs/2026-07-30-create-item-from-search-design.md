# Create an item from the `/items` search empty state

**Date:** 2026-07-30
**Status:** Approved, not yet implemented
**Revision:** 3 — re-verified against `main` at `0602bd4`; see the two revision
sections at the end.

## Problem

An admin doing property-book cleanup searches `/items` for a device, gets "No
items match your search", and has no way forward from that screen. The only
route to creating the missing row is to notice the "+ Log new item" button at
the top of the page, navigate away, and retype the serial they just typed into
the search box. The dead end is exactly where the intent is highest.

## Goal

From the empty state on `/items`, an admin can create the missing item — with
the text they searched for already in the serial field — and land back on the
filtered list seeing the row they just made.

## Non-goals

- No change for non-admin `USER`s. They see today's empty state, unchanged.
- No `detectHomeUnit` / unit-abbreviation resolution on the manual create path.
  That is import-only today and stays that way; `homeUnit` is stored verbatim
  as it already is. The create form *suggests* known unit names (§2.2) but does
  not register new ones — see §6.
- No new item-creation surface. This reuses `/admin/items/new`.
- No change to what a `USER` may edit. Nothing here touches
  `userItemDetailsSchema`.

---

## 1. The affordance

`/items` renders `ItemSelectTable` even when there are zero rows — deliberately,
because the table owns the filter and sort controls and swapping it for an
empty-state card removed the very controls needed to undo the filter. The empty
message therefore lives *inside* the table, at `ItemSelectTable.tsx:297-301`:

```tsx
{items.length === 0 && (
  <div className="card empty">
    No items match {uic ? "this unit and " : ""}your search.
  </div>
)}
```

That block gains a second line, rendered **only when `isAdmin && q.trim()`**:

> No items match your search.
> **[+ Create "ABC12345" as a new item]**

`ItemSelectTable` already receives both `isAdmin` and `q` as props
(destructured `:40-41`, typed `:52-53`), passed at `items/page.tsx:100` and
`:101`. No new plumbing is needed.

The button is a `Link` to:

```
/admin/items/new?serialNumber=<encodeURIComponent(q.trim())>
```

**Conditions, and why:**

- **`isAdmin` only.** Creation is admin-only (`createItemAction` calls
  `requireAdmin()`), so showing a `USER` a button that dead-ends in a redirect
  is worse than showing nothing. The server check remains the authority; this
  is presentation.
- **`q` non-empty only.** An empty result caused by a UIC filter alone gives us
  nothing to prefill and no evidence the admin was hunting a specific device.
  That case keeps today's single-line message.
- **Deliberately NOT suppressed while a UIC filter is active.** `q` + `uic` can
  return zero rows for an item that exists under a *different* UIC, so this
  button can be clicked for a serial that is already in the book. That is
  accepted rather than blocked: an admin filtered to a unit who finds nothing
  may legitimately be adding a device, and blocking the button would be wrong
  more often than right. The duplicate-serial handling in §3.2 is what makes it
  land gracefully — and this, not the case-folding story, is the *main*
  reachable path to that collision.
- The searched text is rendered inside the label, so it is escaped by React
  like any other interpolated string. Truncation is handled per §1.1, not by
  shortening the href.

### 1.1 Styling

The affordance is a **legacy `.btn btn-sm`**, not a Tailwind or `shadcn`
control. `ItemSelectTable` is entirely legacy-styled, and `globals.css:1086-1091`
raises `.btn`/`.btn-sm` to `var(--tap)` at ≤720px, which satisfies the
documented 44px touch floor for free. A bare styled `<Link>` or a `shadcn`
`Button` would ship below that floor and is not used here.

`.btn` is `display:inline-flex` with `white-space:nowrap` (`globals.css:333-350`),
so `text-overflow:ellipsis` on the button itself does nothing — the label is an
anonymous flex item. A long serial would force horizontal overflow of the
`.card` on a phone. The label therefore goes in an inner `<span>` carrying
`min-width:0; overflow:hidden; text-overflow:ellipsis` and a `max-width`, which
is the only form that actually truncates here.

Per `CLAUDE.md`, neither jsdom nor `npm run build` is evidence for any of this.
Verify in a real browser at a phone width with a deliberately long serial.

---

## 2. The new-item form

### 2.1 Prefill

`/admin/items/new/page.tsx` is **already** an async Server Component
(`:6`) that calls `requireAdmin()`. It gains a `searchParams` prop. Per the
Next 16 convention this repo uses (`items/page.tsx:17-27`), `searchParams` is a
**`Promise`** and must be awaited before the existing `firstParam` helper
(`src/lib/search-params.ts:12`) collapses each `string | string[]`.

It passes to `NewItemForm`:

- `serialNumber` — the prefill, used as the `defaultValue` of the serial input.
- `cameFromSearch: boolean` — simply `Boolean(prefill)`. See §3.1.
- `uic` — the UIC filter that was active on `/items`, if any, so the return
  trip can restore it. See §3.1.
- `categories: string[]` — from `listCategoryNames()`, matching the shape
  `EditItemForm` takes (`/admin/items/[itemId]/edit/page.tsx:19`). Note
  `ItemSelectTable` takes `{name:string}[]` instead; follow `EditItemForm`.
- `units: string[]` — the `fullName`s from `listUnits()`
  (`units.service.ts:85`), for the home-unit datalist in §2.2.

Visiting `/admin/items/new` bare behaves exactly as it does today.

**On `?serialNumber=` being a URL parameter:** it is inert. It becomes the
`defaultValue` of a text input and nothing else — it never reaches a redirect
target, a query, a raw SQL fragment, or `dangerouslySetInnerHTML`. On submit it
is validated by `newItemSchema` like any other field. There is deliberately
**no `returnTo` parameter**; see §3.1.

**Length bound.** `serialNumber` had **no `.max()`** before this feature
(`items.schema.ts:54`), so a pasted 5,000-character value would have submitted
and landed in the citext-unique column. Capping only the prefilled
`defaultValue` would protect nothing — the bound belongs on the schema.
Production's longest real serial was checked (`SELECT
max(length(serial_number)) FROM items`) and came back **14 characters**, so
`identityItemFields.serialNumber` shipped with **`.max(64)`** — generous
headroom over the real data rather than a guess. Note this is a *shared*
definition: it also applies to `itemIdentitySchema`, so an existing over-long
serial (there are none in production today) would be rejected the next time
someone re-saves that item's identity.

### 2.2 Two new fields

`NewItemForm` today renders make\*, model\*, serialNumber\*, deviceName\*,
homeUnit, and a notes textarea. It gains:

- **`deviceUIC`** — plain optional text.
- **`deviceCategory`** — text input backed by a `<datalist>` of the existing
  vocabulary, matching the pattern already used by `EditItemForm.tsx:63,69-73`
  (`list="device-category-options"`).

Field order: make\*, model\*, serial\*, device name\*, home unit, UIC,
category, notes.

**Why a datalist and not a strict `<select>`:** `Item.deviceCategory` is a
denormalized string and deliberately not a foreign key, precisely so a CSV
import can carry a category the property book has not registered yet. A create
form that *refused* an unknown category would be stricter than the importer —
the same device would sail through as a CSV row and be rejected when typed by
hand. `learnCategories` (§2.4) is what keeps this honest: a newly typed
category is registered, so it appears in the picker next time instead of
becoming an orphan string.

**`homeUnit` also gains a datalist** — the existing `Unit.fullName`s from
`listUnits()`. The field itself is unchanged (still free text, still stored
verbatim); this only *suggests* the spellings the vocabulary already knows, so
a hand-typed home unit lands on an existing `Unit` rather than inventing a
second spelling of one. That matters because `renameUnit` backfills items by
matching the old `fullName`: a drifted spelling is silently left behind by
every future rename. `listUnits` did not exist when revision 1 was written; it
landed with the `/admin/units` work.

**Known consequence, not a bug:** whatever home unit the admin types here is
not permanent. The CSV importer is the source of truth for `homeUnit` and
overwrites it on every matched row — via the CSV's own column, or a re-run
`detectHomeUnit` — so the next nightly import carrying a value for this device
wins. `CLAUDE.md` already records this for `renameUnit`'s backfill; the same
applies to a hand-created item.

`currentUserEmail` and `currentPosition` are **not** added. A device being
entered into the book is not yet issued to anyone; those are set when it is.

### 2.3 Schema changes — `items.schema.ts`

`z.object()` strips unknown keys, so a field the form renders but the schema
does not declare parses cleanly, is dropped, and the form reports success while
saving nothing. That bug has shipped twice in this codebase. Both new fields
must therefore be declared:

```ts
export const newItemSchema = z.object({
  ...identityItemFields,
  deviceName: z.string().trim().min(1, "Device name is required"),
  homeUnit: optional,
  deviceUIC: optional,
  deviceCategory: categoryNew,
  notes: optional,
});
```

`categoryNew` is a **third** category variant, added next to the existing two
with a comment explaining why all three exist:

```ts
/** Category cell for the CREATE form. Blank -> undefined like
 *  `categoryOptional` (there is no prior value to clear on a row that does not
 *  exist yet, and writing "" would put an empty string in an indexed column
 *  that every filter and count treats as a value). But over-long names are
 *  REJECTED with a message like `categoryClearable`, not silently dropped: a
 *  form that says "Created" while discarding what was typed is the exact bug
 *  the note on `categoryClearable` warns about. Same `normalizeCategoryName`
 *  as both. */
const categoryNew = z
  .string()
  .trim()
  .transform((v) => normalizeCategoryName(v))
  .refine(
    (v) => v.length <= MAX_CATEGORY_NAME,
    `Category names are limited to ${MAX_CATEGORY_NAME} characters.`,
  )
  .transform((v) => v || undefined)
  .optional();
```

Neither existing variant fits: `categoryOptional` is import-only and *drops*
over-long values silently; `categoryClearable` keeps `""` and would write an
empty string into a fresh row.

The trailing `.optional()` is **load-bearing, not decoration**: `createItem`
re-parses its input through `newItemSchema` (`items.service.ts:19`) as defense
at the service boundary, so the schema must accept its own output. Zod v4's
optional short-circuits `undefined` *input* before running the inner type
(`node_modules/zod/v4/core/schemas.js:1767-1770`), which is what makes the
round-trip work — this is not merely object-level optionality. Without it,
every create with a blank category would fail on the second parse. The existing
`optional` helper ends the same way for the same reason, and `homeUnit`/`notes`
already round-trip through `createItem` today, proving the pattern.

Refine-then-transform order is deliberate and verified: `""` normalizes to `""`,
passes the `<= 60` refine, then becomes `undefined`.

### 2.4 Registering the category — OUTSIDE the item write

After a successful create, the action calls `learnCategories([category])`
**sequentially after the item has committed, in its own try/catch that swallows
its own failure** — following the two existing single-item precedents
(`src/app/actions/items.ts:47-63` and `src/app/admin/actions/items.ts:61-72`),
both of which carry explicit comments saying why: reporting a vocabulary-insert
failure as "something went wrong saving your changes" would tell the admin
their write did not land when it did.

`createItem` therefore stays a bare `prisma.item.create` and keeps its existing
comment about needing no transaction.

**This is the opposite of what revision 1 of this spec said**, and the reason
matters. Revision 1 put the learn *inside* a transaction with the item create,
justified as "a second write that must not land without the item." That is
backwards: running it sequentially afterwards already guarantees the category
cannot land without the item, because the item has committed by then. Wrapping
them together only adds a new failure mode — a vocabulary insert failing would
roll back a perfectly good item.

`setItemsCategory` (`items.service.ts:551-556`) *does* learn in-transaction, but
it is not a precedent for this: its comment documents a delete-race specific to
picking a *pre-existing* category from a rendered list, which cannot apply to a
category typed fresh on a create form.

`learnCategories` already accepts a `Prisma.TransactionClient` (defaulting to
`prisma`), already no-ops on `undefined`, blank-after-normalize and over-long
names, and returns `0` without issuing a query when there is nothing to insert
(`categories.service.ts:136-147`). Calling it with a blank category costs
nothing.

**This makes create the FIFTH normalize-then-learn write site.** `CLAUDE.md`
currently says four (CSV import, admin edit page, item card, bulk selection
bar). That line is updated in the same commit.

---

## 3. Submit, redirect, and the collision case

### 3.1 Where the admin lands

**Signalling that the form came from search.** `createItemAction` receives only
`FormData`, so `NewItemForm` renders two hidden inputs when it was opened with
a prefill: `fromSearch="1"` and `returnUic` (empty when no UIC filter was
active). Both are read **directly off `formData`**, never off `parsed.data` —
`newItemSchema` is a `z.object()` and strips unknown keys, so they would
silently vanish if read from the parsed result. This is the mechanism revision 1
of this spec left unspecified.

When `fromSearch` is set, the action redirects to `/items` with the search
restored:

```ts
const params = new URLSearchParams({ q: item.serialNumber });
if (returnUic) params.set("uic", returnUic);
redirect(`/items?${params}`);
```

`URLSearchParams` handles the encoding. Building the string by concatenation
would mangle any serial containing `&`, `#`, `+` or a space and land the admin
on an empty list for the item they just created — the exact opposite of the
"proof it worked" this redirect exists to provide.

The admin lands on the filtered list with the row they just made visible,
already positioned to search the next missing serial, with their unit filter
intact.

**There is still no redirect target in the URL, and none is caller-supplied in
any meaningful sense.** The path `/items` is hardcoded in the action. `q` is
read back off the row Prisma just wrote. `returnUic` only ever becomes a query
*value* on that fixed path, never a destination — so there is no open redirect
here, which a `returnTo` parameter would have been.

Which of two hardcoded destinations applies:

- `fromSearch` set → `redirect("/items?…")`
- opened bare from "+ Log new item" → today's in-place success card
  ("Item created successfully" / Add another / Back to items), unchanged.

**Implementation note:** `redirect()` works by throwing `NEXT_REDIRECT`, and
Next 16's own docs say it "should be called outside the `try` block"
(`node_modules/next/dist/docs/01-app/03-api-reference/04-functions/redirect.md`).
Called inside the P2002 catch, it would be swallowed and silently become a
generic error.

**Revalidation.** `createItemAction` gains `revalidatePath` for three paths:

- `/items` — the list the admin returns to.
- `/admin/categories` — its in-use counts (`categories.service.ts:36-60`) go
  stale the moment `learnCategories` registers a new name.
- `/admin/analytics` — fleet counts change; `markItemsReadyAction` already
  revalidates it for the same reason (`admin/actions/items.ts:171`).

Note this is **not** fixing a stale-server-render bug. `/items` calls
`requireUser()` → `auth()` → `cookies()` (`src/lib/authz.ts:27-37`), so the
route is dynamically rendered on every request and there is no cached server
render to invalidate. Revision 1 claimed otherwise and was wrong. The
revalidation is still worth adding — it clears the client Router Cache, which
governs back-navigation and prefetched links — but it is a correctness nicety,
not a bug fix.

### 3.2 Duplicate serial

`Item.serialNumber` is `@unique @db.Citext`, and `createItemAction` has **no
P2002 handling today** (`admin/actions/items.ts:25-33` — no try/catch at all).
A duplicate serial is an unhandled throw.

This feature makes that reachable. The path is the UIC filter described in §1:
`/items?q=ABC123&uic=WXYZ` shows "No items match this unit and your search" for
an item that exists under a *different* UIC, and the create button is offered.

Two things revision 1 got wrong here, worth recording so they are not
reintroduced:

- **A case-only difference is NOT a path to this.** `listItems` searches
  `serialNumber: { contains: search, mode: "insensitive" }`
  (`items.service.ts:261`), so a serial differing only in case *is* found and
  the empty state never appears.
- **RETIRED items are NOT hidden.** `listItems` applies no status filter
  (`items.service.ts:254-267`), so a retired device with that serial shows up
  in search results normally. There is no invisible-retired-row trap.

So `createItemAction` wraps the create in a try/catch and, on
`Prisma.PrismaClientKnownRequestError` with code `P2002`, returns a specific
error naming the serial, following the message shape `updateItemIdentityAction`
already uses (`admin/actions/items.ts:119-124`):

> Serial number "ABC12345" already belongs to an item. Serial numbers are
> unique and ignore case — open that item instead.

Because the whole point is that the admin wants to *reach* that device, the
action also does a single `findUnique` on the error path to resolve the
existing item's id and returns it as `existingItemId`; the form renders it as a
link to `/i/<id>`. If that lookup finds nothing (deleted in between), the error
renders without a link rather than failing.

Leaning on the constraint rather than pre-checking with a `findUnique` is
deliberate — a pre-check races.

---

## 4. Files touched

| File | Change |
|---|---|
| `src/components/ItemSelectTable.tsx` | Empty state gains the admin-only create link (§1, §1.1) |
| `src/components/ItemSelectTable.test.tsx` | New component test (jsdom opt-in) covering the empty-state create link (§5) |
| `src/app/admin/items/new/page.tsx` | Await `searchParams`, fetch `listCategoryNames()` + `listUnits()`, pass prefill + uic down |
| `src/app/admin/items/new/NewItemForm.tsx` | Prefill, two new fields, two datalists, hidden `fromSearch`/`returnUic`, collision link |
| `src/modules/items/items.schema.ts` | `categoryNew`; `deviceUIC` + `deviceCategory` on `newItemSchema`; `.max()` on `serialNumber` |
| `src/app/admin/actions/items.ts` | `revalidatePath` ×3, `learnCategories`, conditional redirect, P2002 handling |
| `src/app/actions/items.test.ts` | `createItemAction` tests added to the **existing** file — see §5 |
| `src/modules/items/items.service.ts` | `getItemBySerial` added, used to resolve the P2002 branch's collision link |
| `src/app/globals.css` | `.truncate-inline` rule (§1.1), used by the create link's label span |
| `CLAUDE.md` | "FOUR write sites" → five; note the create path's category handling |
| `CHANGELOG.md` | Append to the **existing** `## 2026-07-30` section, not a second heading |

**`docs/SECURITY.md` is not triggered.** None of these files match any regex in
`scripts/check-security-docs.mjs:23-86`. (`admin/actions/items.ts` is
explicitly called out as deliberately unwatched, in a comment attached to the
`readiness.ts` entry at `:77-79`.) Confirm with `npm run check:security-docs`
before opening the PR rather than assuming.

**No other consumer of `newItemSchema` exists.** Its only runtime consumers are
`createItemAction` (`admin/actions/items.ts:27`) and `createItem`
(`items.service.ts:19`); `planImport` parses through `importRowSchema` and uses
its own `NewItemImport` type (`import.ts:33-49`). Adding two optional fields
leaks nowhere. A category set at creation also breaks nothing downstream —
`Item.deviceCategory` is already nullable and both edit surfaces already handle
it (`ItemDetailsCard.tsx:164`, `EditItemForm.tsx:62`).

## 5. Testing

**Unit (`items.schema.test.ts`):**
- `categoryNew`: blank → `undefined`; internal whitespace collapsed; a name
  over `MAX_CATEGORY_NAME` is **rejected with a message**, not dropped.
- `newItemSchema` accepts and retains `deviceUIC` and `deviceCategory` — the
  direct regression test for the strip-unknown-keys bug.
- `newItemSchema.parse(newItemSchema.parse(x))` round-trips with a blank
  category — the regression test for the `.optional()` in §2.3.

**Action (`src/app/actions/items.test.ts` — existing file):**
`createItemAction` is untested today. It is added to
`src/app/actions/items.test.ts`, which already imports and tests
`updateItemIdentityAction` from the admin actions module and carries every
mock (authz, `items.service`, etc.) both actions need — no new test file.
Action tests in this repo live at `src/app/**/actions/*.test.ts` and mock
authz with `vi.mock("@/lib/authz")`; they do **not** belong in
`items.service.test.ts`, which is a real-DB file that imports service
functions only and has no authz mock.
- Happy path with `fromSearch` set asserts `rejects.toThrow("NEXT_REDIRECT")`,
  the existing pattern at `src/app/actions/auth.rate-limit.test.ts:139`.
- Happy path *without* `fromSearch` returns `{ itemId }` and does not throw.
- A serial containing `&` and a space produces a correctly encoded redirect.
- A duplicate serial returns the named error plus `existingItemId`.

**Integration (real DB):** none added for `learnCategories` on the create
path, and none pre-existed to extend — there is no real-DB suite over
`categories.service.ts` today (only `categories.normalize.test.ts`, which
covers the pure `normalizeCategoryName` helper, not the DB-backed
`learnCategories`). The learn-a-new-category behavior is instead covered at
the action level (§ Action, above), with `learnCategories` mocked and
asserted on: called with the normalized name on a create that types one,
not called when the category is blank, and the create still reports success
when the mocked call rejects. This is deliberate, not a gap left open by
this feature — the learn call lives entirely in `createItemAction`
(`data.deviceCategory ? learnCategories(...) : ...`), so an action-level
mock proves the wiring, and a real-DB assertion on `learnCategories` itself
belongs to `categories.service.ts`, which has no such suite yet regardless
of this change.

**Component (`test:ui`, jsdom opt-in):**
- Empty state renders the create link with the searched text when
  `isAdmin && q`, and renders neither for a `USER` nor for a blank `q`.

**Not evidence:** per `CLAUDE.md`, neither jsdom nor `npm run build` has a
layout engine, so neither proves anything about §1.1. Verify in a real browser.

## 6. `homeUnit`: suggest, don't learn

Review raised that the create path registers a typed category but not a typed
home unit, leaving `Item.homeUnit` able to hold a string matching no
`/admin/units` row — asymmetric with the §2.2 argument that a create form
should not be stricter than the importer.

**Half adopted.** The field gets a datalist of existing `Unit.fullName`s
(§2.2), which addresses the actual harm: an admin picking a known spelling
instead of inventing a new one.

**`learnUnits` is still not called, because the two vocabularies are not the
same shape.** It takes `UnitResolution` records keyed on `abbreviation`, which
is `Unit`'s citext-unique identity (`units.service.ts:35-60`) — a hand-typed
`homeUnit` is a bare `fullName` with no abbreviation, so there is nothing to
learn it *as*. The import can only call `learnUnits` because it derives both
halves. `DeviceCategory` is a single name, so a typed category is complete on
its own; a unit is not.

Fully closing the gap means asking the admin for an abbreviation, which turns
a create form into a vocabulary-management surface — that is what
`/admin/units` is for. Out of scope here.

---

## Review corrections

Revision 2 changed the following after review. Recorded because each was stated
confidently and wrongly in revision 1:

1. `learnCategories` moved **out** of a transaction with the item create — the
   two single-item precedents deliberately run it outside and swallow its
   failure (§2.4).
2. The "opened with a prefill" signal was never specified; it is now two hidden
   inputs read directly off `formData` (§3.1).
3. The return URL is built with `URLSearchParams`; raw concatenation would
   mangle serials containing `&`, `#`, `+` or a space (§3.1).
4. The duplicate-serial reachability argument was wrong — a case-only
   difference *is* found by search, and RETIRED items are *not* hidden. The
   real path is an active UIC filter (§3.2).
5. `revalidatePath("/items")` does not fix a stale server render; `/items` is
   dynamic. It clears the client Router Cache (§3.1).
6. The 200-char prefill cap protected nothing; the bound belongs on the schema
   (§2.1).
7. `text-overflow: ellipsis` on a `.btn` is a no-op; it needs an inner span
   (§1.1).
8. Action tests belong in the **existing** `src/app/actions/items.test.ts`,
   which already imports and mocks everything both `createItemAction` and
   `updateItemIdentityAction` need — not in a new
   `src/app/admin/actions/items.test.ts`, and not in the real-DB service test
   file (§5).
9. `/admin/items/new/page.tsx` is already an async Server Component, and
   `searchParams` is a Promise that must be awaited (§2.1).
10. Line citations corrected: empty state is `ItemSelectTable.tsx:297-301`;
    props are passed at `items/page.tsx:100,101`.

---

## Revision 3 — re-verified against `main` at `0602bd4`

`main` moved substantially between revision 2 and now: bulk unit management
(`/admin/units`), a machine-driven CSV import endpoint, and readiness changes
all landed, and `/items` had columns, sorting and filters reworked. Every
load-bearing claim in this spec was re-checked against the merged code rather
than trusted.

**Still true, verified:**

- The empty state is untouched at `ItemSelectTable.tsx:297-301`, and `isAdmin`
  / `q` are still props. The `/items` rework did not reach either.
- `listItems` still takes exactly two filters, `search` and `uic`
  (`items.service.ts:241-249`), still `contains` + `mode:"insensitive"` across
  the same four fields (`:258-261`), and still applies **no status filter** —
  so the §3.2 reasoning about which collisions are reachable is unchanged, and
  no new filter dimension needs a caveat alongside UIC.
- `newItemSchema` is still six fields with no `deviceUIC`/`deviceCategory`, and
  `serialNumber` still has no `.max()` (`items.schema.ts:51-62`).
- `createItemAction` still has no `revalidatePath`, no try/catch and no P2002
  handling (`admin/actions/items.ts:25-33`); `createItem` is still a bare
  create that re-parses its input (`items.service.ts:18-25`).
- Both learn-outside-the-transaction precedents are intact and now carry even
  more explicit comments (`admin/actions/items.ts:61-72`,
  `app/actions/items.ts:47-63`), confirming §2.4.
- `markItemsReadyAction` still revalidates `/admin/analytics`
  (`admin/actions/items.ts:170-171`), the precedent §3.1 follows.
- None of the files in §4 are on the `check-security-docs` watch list —
  re-checked by evaluating every regex in the script against each path, not by
  reading it.
- `CHANGELOG.md` still has a `## 2026-07-30` section (now with `Added` and
  `Fixed`); the entry appends there.

**Changed by the merge, and now reflected above:**

- `listUnits()` exists (`units.service.ts:85`), so `homeUnit` gets a datalist.
  §6 went from "rejected" to "half adopted" on the strength of it.
- The CSV importer overwriting `homeUnit` on matched rows is now merged, so a
  hand-typed home unit is explicitly documented as non-permanent (§2.2).
