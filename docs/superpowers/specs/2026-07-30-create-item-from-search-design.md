# Create an item from the `/items` search empty state

**Date:** 2026-07-30
**Status:** Approved, not yet implemented

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
  as it already is.
- No new item-creation surface. This reuses `/admin/items/new`.
- No change to what a `USER` may edit. Nothing here touches
  `userItemDetailsSchema`.

---

## 1. The affordance

`/items` renders `ItemSelectTable` even when there are zero rows — deliberately,
because the table owns the filter and sort controls and swapping it for an
empty-state card removed the very controls needed to undo the filter. The empty
message therefore lives *inside* the table, at `ItemSelectTable.tsx:295-303`:

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
(`items/page.tsx:100,102`), so no new plumbing is needed.

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
- The searched text is rendered inside the label, so it is escaped by React
  like any other interpolated string. Long values are visually truncated with
  CSS (`text-overflow: ellipsis`), not cut from the href.

---

## 2. The new-item form

### 2.1 Prefill

`/admin/items/new/page.tsx` becomes a Server Component that reads
`searchParams` and passes two things to `NewItemForm`:

- `serialNumber` — the prefill, used as the `defaultValue` of the serial input.
  Collapsed with the existing `firstParam` helper (params are
  `string | string[]`) and **capped at 200 characters** before it reaches the
  input, so a pathological URL cannot produce an absurd field value.
- a derived `cameFromSearch: boolean` — simply `Boolean(prefill)`. See §3.

Visiting `/admin/items/new` bare behaves exactly as it does today.

**On `?serialNumber=` being a URL parameter:** it is inert. It becomes the
`defaultValue` of a text input and nothing else — it never reaches a redirect
target, a query, a raw SQL fragment, or `dangerouslySetInnerHTML`. On submit it
is validated by `newItemSchema` like any other field. There is deliberately
**no `returnTo` parameter**; see §3.

### 2.2 Two new fields

`NewItemForm` today renders make\*, model\*, serialNumber\*, deviceName\*,
homeUnit, and a notes textarea. It gains:

- **`deviceUIC`** — plain optional text.
- **`deviceCategory`** — text input backed by a `<datalist>` of the existing
  vocabulary, matching the pattern already used by
  `EditItemForm.tsx:63,69-73` (`list="device-category-options"`). The page
  fetches the options with `listCategoryNames()`, as
  `/admin/items/[itemId]/edit/page.tsx:19` already does.

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

The trailing `.optional()` is **load-bearing, not decoration**: `createItem`
re-parses its input through `newItemSchema` as defense at the service boundary,
so the schema must accept its own output. Without `.optional()`, a blank
category becomes `undefined` on the first parse and then fails
`z.string()` on the second — every create with no category would break.
`categoryOptional` and the `optional` helper already end this way for the same
reason.

Neither existing variant fits: `categoryOptional` is import-only and *drops*
over-long values silently; `categoryClearable` keeps `""` and would write an
empty string into a fresh row.

### 2.4 Service change — `createItem`

`createItem` (`items.service.ts:18-25`) is today a bare `prisma.item.create`
with an explicit comment that it needs no transaction, because readiness is
derived and a new item has no history to record. That reasoning still holds for
history — but registering the category is a second write that must not land
without the item, so it becomes a two-statement transaction mirroring
`setItemsCategory` (`items.service.ts:556`):

```ts
return prisma.$transaction(async (tx) => {
  const item = await tx.item.create({ data: { ...data, createdById } });
  await learnCategories([data.deviceCategory], tx);
  return item;
});
```

`learnCategories` already accepts a `Prisma.TransactionClient`, already
no-ops on `undefined`, and already does a single `createMany({ skipDuplicates:
true })` — so this is one extra statement, not a per-row loop.

The comment about "no history row" stays; it is still true and still worth
explaining.

**This makes create the FIFTH normalize-then-learn write site.** `CLAUDE.md`
currently says four (CSV import, admin edit page, item card, bulk selection
bar). That line is updated in the same commit.

---

## 3. Submit, redirect, and the collision case

### 3.1 Where the admin lands

`createItemAction` gains `revalidatePath("/items")`. This is **missing today**
— nothing on the create path revalidates anything — so a cached `/items` render
can omit the item that was just created. That is a latent bug this feature
would otherwise make very visible.

Then, **when the form was opened with a prefill**, the action redirects to:

```
/items?q=<the created item's serialNumber>
```

The admin lands on the filtered list with the row they just made visible —
proof it worked — already positioned to search the next missing serial.

**There is no redirect parameter anywhere in this design.** The destination is
*derived*: the serial is read back off the row Prisma just wrote, so the target
is app-controlled data, never a caller-supplied string. A `returnTo` querystring
would be an open redirect on an authenticated admin page immediately after a
successful action — a good phishing primitive, and unnecessary here.

The only thing the URL influences is *which of two hardcoded destinations*
applies, not *where*:

- opened with a prefill (came from search) → `redirect("/items?q=…")`
- opened bare from "+ Log new item" → today's in-place success card
  ("Item created successfully" / Add another / Back to items), unchanged.

**Implementation note:** `redirect()` works by throwing `NEXT_REDIRECT`. It must
be called **outside** the `try` block that catches P2002, or the catch swallows
it and the redirect silently becomes a generic error.

### 3.2 Duplicate serial

`Item.serialNumber` is `@unique @db.Citext`, and `createItemAction` has **no
P2002 handling today** — a duplicate serial is an unhandled throw.

This feature makes that reachable. The premise is "the search found nothing, so
create it", but the search is a `contains` match across four fields while
creation collides on serial alone. A serial that differs only in case, or an
admin who mistypes the search but types the serial correctly on the form, lands
straight on the constraint.

So `createItemAction` catches `Prisma.PrismaClientKnownRequestError` with code
`P2002` and returns a specific error naming the serial, following the message
shape `updateItemIdentityAction` already uses (`admin/actions/items.ts:119-124`):

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
| `src/components/ItemSelectTable.tsx` | Empty state gains the admin-only create link |
| `src/app/admin/items/new/page.tsx` | Read `searchParams`, fetch `listCategoryNames()`, pass prefill down |
| `src/app/admin/items/new/NewItemForm.tsx` | Prefill, two new fields, category datalist, collision link |
| `src/modules/items/items.schema.ts` | `categoryNew`; `deviceUIC` + `deviceCategory` on `newItemSchema` |
| `src/modules/items/items.service.ts` | `createItem` becomes a txn + `learnCategories` |
| `src/app/admin/actions/items.ts` | `revalidatePath`, conditional redirect, P2002 handling |
| `CLAUDE.md` | "FOUR write sites" → five; note the create path's category handling |
| `CHANGELOG.md` | User-facing entry under `## 2026-07-30` |

**`docs/SECURITY.md` is not triggered.** `admin/actions/items.ts` is
explicitly excluded from the `check-security-docs` watch list (with a comment
saying why: it churns for unrelated reasons), and neither `items.schema.ts` nor
`ItemSelectTable.tsx` is watched. Confirm with `npm run check:security-docs`
before opening the PR rather than assuming.

## 5. Testing

**Unit (`items.schema.test.ts`):**
- `categoryNew`: blank → `undefined`; internal whitespace collapsed; a name
  over `MAX_CATEGORY_NAME` is **rejected with a message**, not dropped.
- `newItemSchema` accepts and retains `deviceUIC` and `deviceCategory` — the
  direct regression test for the strip-unknown-keys bug.

**Integration (`items.service.test.ts`, real DB):**
- Creating an item with a category not in the vocabulary registers it, so
  `listCategoryNames()` then contains it.
- Creating with a blank category registers nothing.
- Creating a serial that already exists in different casing raises P2002, and
  `createItemAction` returns the named error plus the existing item's id.

**Component (`test:ui`, jsdom opt-in):**
- Empty state renders the create link with the searched text when
  `isAdmin && q`, and renders neither for a `USER` nor for a blank `q`.

**Not evidence:** per `CLAUDE.md`, neither jsdom nor `npm run build` has a
layout engine, so neither proves anything about how the new empty state and the
widened form actually look. Verify in a real browser.
