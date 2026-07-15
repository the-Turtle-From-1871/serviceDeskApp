# Contact book — shared recipient book with autofill on the hand-receipt builder

**Date:** 2026-07-15
**Status:** Approved

## Goal

Give the desk a shared, org-wide book of recipients so a hand receipt's recipient
fields can be filled by picking a saved contact instead of re-typing five fields.
Admins manage the book on `/admin/users`; every signed-in user gets a type-ahead
on the recipient side of the hand-receipt builder (`/receipts/new`).

## Vocabulary note

The request called these the "Transfers page" and the "Users page". In this repo:

- The transfer workflow is the **hand-receipt builder** at `/receipts/new`
  (`ReceiptBuilderForm.tsx`); `Transfer` is the Prisma model behind it. The
  recipient fields are `PartyFields role="receiver"`.
- The **Users page** is `/admin/users`, which is admin-gated by `requireAdmin()`
  and redirects non-admins. A standard USER cannot reach it. Hence the split
  below: management is admin-only, autofill is open to any signed-in user.

## Scope

**New:**
- `prisma/schema.prisma` — `Contact` model + `User.createdContacts` back-relation.
- `src/modules/contacts/contacts.schema.ts`
- `src/modules/contacts/contacts.service.ts`
- `src/modules/contacts/contact-match.ts`
- `src/modules/contacts/contact-match.test.ts`
- `src/app/admin/actions/contacts.ts`
- `src/app/admin/actions/contacts.test.ts`
- `src/app/admin/users/ContactBookSection.tsx`
- `src/components/ContactCombobox.tsx`

**Modified:**
- `src/app/admin/users/page.tsx` — render `ContactBookSection`.
- `src/app/receipts/new/page.tsx` — load contacts inside the existing `Promise.all`.
- `src/app/receipts/new/ReceiptBuilderForm.tsx` — lift four `PartyFields` values
  to state; render the combobox for the non-DCSIM recipient.
- `src/components/PhoneInput.tsx` — add an optional controlled mode.

## Design rationale: why there is no concurrency machinery here

The original request asked for parallel query execution and React concurrent
rendering (`useTransition` / `useDeferredValue` / streaming) to keep typing
fluid. That was assessed and deliberately **not** built, because it would add
real complexity for no measurable gain:

- A contact lookup is one indexed query returning ~10 rows. "Fetch matches
  concurrently with validation or asset loading" requires a second async task to
  overlap with; during a keystroke there isn't one. Signatures and last-receivers
  already load once at page render, not per keystroke.
- `useTransition` / `useDeferredValue` address render-blocking from expensive
  component trees (thousands of nodes). An 8-row dropdown is not that, and
  neither hook addresses network latency — the only real cost in this feature.
- Typing is never blocked by an `await`. Controlled-input state updates are
  synchronous and cheap.

The design instead removes the network from the keystroke path entirely (see
Requirement 4). Filtering an in-memory array is faster than any concurrent fetch
strategy, and it eliminates the debounce, the race guard, and the stale-response
class of bug outright.

The one place parallelism genuinely pays is page load, and the design uses it
there: contacts join the **existing** `Promise.all` in `receipts/new/page.tsx`,
so the contact query overlaps the signature and last-receiver queries rather than
adding a third serial round-trip.

## Requirements

### 1. Schema

```prisma
model Contact {
  id            String   @id @default(cuid())
  rank          String?
  firstName     String
  lastName      String
  unit          String?
  contactNumber String?
  email         String   @unique @db.Citext
  createdBy     User?    @relation("CreatedContacts", fields: [createdById], references: [id], onDelete: SetNull)
  createdById   String?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  @@index([lastName, firstName])
}
```

Plus `createdContacts Contact[] @relation("CreatedContacts")` on `User`.

- `@db.Citext` on `email` mirrors the `User.email` precedent: the unique
  constraint and every lookup ignore case, so a mixed-case row can't hide from
  the app's lowercased lookups or duplicate its lowercase twin.
- `@unique` on `email` is the dedupe key — one inbox, one contact.
- Nullable `createdBy` + `onDelete: SetNull` mirrors `ItemEdit` and
  `ReturnTransaction`: the book survives deletion of the account that added a row.
- `firstName`/`lastName` are split columns so last-name ordering is a plain
  indexed DB sort with no name-parsing heuristics (which misfile "Van Der Berg"
  and "Doe Jr."). `Transfer.receiverName` stays a single `String`; autofill
  composes `${firstName} ${lastName}` when filling it.
- `rank`/`unit`/`contactNumber` optional, mirroring `newUserSchema`.

Migration is authored with `prisma migrate diff --script` + `prisma migrate
deploy` (`migrate dev` cannot run non-interactively in this shell), and applied
to the remote DB **before** pushing.

### 2. Module layer

- **`contacts.schema.ts`** — `newContactSchema` and `updateContactSchema`.
  Imports the already-exported `emailField` from `users.schema.ts` rather than
  redefining it: that transform is the canonical lowercaser, and it must agree
  with `citext` or the unique constraint and lookups diverge. `rank`/`unit`/
  `contactNumber` use the local trim-to-undefined idiom (`optionalText`).
- **`contacts.service.ts`** — `listContacts()`, `createContact()`,
  `updateContact()`, `deleteContact()`. `listContacts` orders
  `[{ lastName: "asc" }, { firstName: "asc" }]`. Parses through the schema before
  writing, as `users.service.ts` does.
- **`contact-match.ts`** — a pure `matchContacts(contacts, query, limit)`. No
  DB, no React, no imports from Prisma — so it unit-tests in milliseconds and can
  be reused if the lookup ever moves server-side.

### 3. Admin actions and UI

`src/app/admin/actions/contacts.ts` mirrors `admin/actions/users.ts` exactly:
`requireAdmin()` first, `safeParse` the `FormData`, return
`{ error: <first issue message> }` on invalid input, catch write failures and
return a generic message (duplicate email → "A contact with that email already
exists."), then `revalidatePath("/admin/users")`.

`ContactBookSection.tsx` renders on `/admin/users` below the existing "Add a
user" card:
- An add form (rank, first name, last name, email, unit, contact number) using
  the `form-grid` / `field` / `label` / `input` classes and `useActionState`, as
  `NewUserForm` does. `PhoneInput` for the contact number; `RANK_OPTIONS`
  datalist for rank.
- A table in `table-wrap` showing **`Doe, Jane`**, email, unit, contact number,
  and actions (Edit, Delete), ordered by last name then first name. `data-label`
  attributes on cells for the existing mobile-responsive table styling.
- **Edit** toggles that row into an inline edit form (client state, one row
  editable at a time) with the same fields as the add form, seeded from the row
  and posting to `updateContactAction` with a hidden `id`; Cancel restores the
  read-only row.
- **Delete** is a `<form action={deleteContactAction}>` with a hidden `id`,
  matching the existing role/active toggle idiom on the page. Deleting a contact
  does not touch any `Transfer` — recipient details are copied onto the receipt
  at creation, so past receipts are unaffected.

Reads are open to any signed-in user (`requireUser`) via the builder page; all
**writes** are `requireAdmin`.

### 4. Autofill on the hand-receipt builder

**Loading.** `receipts/new/page.tsx` adds `listContacts()` to the existing
`Promise.all` (currently `[signatures, lastReceivers]`), then passes a mapped
contact array to `ReceiptBuilderForm` carrying only the fields the combobox needs
(`id`, `rank`, `firstName`, `lastName`, `unit`, `contactNumber`, `email`) — audit
columns (`createdById`, timestamps) stay out of the RSC payload.

**Filtering.** `ContactCombobox` filters the in-memory array on each keystroke.
No fetch, no debounce, no race guard, no `resolvedKey` settle-gate — none of
which are needed when there is no async boundary.

**State lifting.** `PartyFields` currently uses `defaultValue` (uncontrolled) for
rank, unit, contact, and email. Autofill requires driving them, so all four
become `PartyFields`-local state seeded from `prefill`. This is the same lifting
the file already documents for `name` and for `ServiceControls.note`. Because the
state is local and seeded from `prefill`, the **sender side is behaviorally
unchanged** — it still prefills from last-receiver and stays editable.

`name` stays parent-owned (`ReceiptBuilderForm`), because the DCSIM signature
interplay already depends on it there.

**Where the combobox renders.** Only when `role === "receiver" && !isDcsim`:
- When `isDcsim` is true those four fields are not rendered at all, and `name`
  means "DCSIM technician name" — our own staff, who have accounts and a saved
  signature picker, not contact-book entries.
- The existing `hideName` path (DCSIM + a picked signature) is untouched.

**On select**, the combobox sets `name` (via the parent's `onNameChange`, to
`${firstName} ${lastName}`) and the four local values in one interaction. Absent
optional fields fill as empty strings, leaving the existing `required` validation
to prompt the user — an incomplete contact degrades to a partially-filled form,
never a blocked one. Every field stays editable after autofill; selecting a
contact is a starting point, not a lock.

### 5. Matching rules

`matchContacts(contacts, query, limit = 8)`:
- Case-insensitive substring match against a per-contact haystack of:
  `"first last"`, `"last first"`, `email`, `unit`.
- **Rank is excluded** — it is a low-cardinality field, so typing `SGT` would
  return half the book.
- Blank/whitespace query → empty result (dropdown closed).
- Input arrives already sorted by last name from the DB and filtering preserves
  order, so results need no re-sort.
- Capped at 8 results.

### 6. Accessibility

A real combobox, not a styled div: `role="combobox"` with `aria-expanded`,
`aria-controls`, and `aria-activedescendant` on the input; `role="listbox"` /
`role="option"` on the dropdown. Keyboard: ArrowDown/ArrowUp move the active
option, Enter selects, Escape closes, blur closes. Result-count changes are
announced via the `aria-live="polite"` idiom established in `HomeSearch.tsx`.

### 7. Tests

- `contact-match.test.ts` — pure unit tests: field coverage, "first last" and
  "last first" order, case-insensitivity, rank exclusion, blank query, the cap,
  and order preservation. No DB.
- Integration tests alongside `receipts.test.ts` / `search.test.ts`: the
  `requireAdmin` gate on each write action, duplicate-email rejection,
  case-insensitive email dedupe (citext), and last-name ordering from
  `listContacts`.

The suite must not be run while another agent is running it — the integration
tests share one test DB and truncate each other.

## Data flow

**Management:** `/admin/users` (server, `requireAdmin`) → `listContacts()` →
`ContactBookSection` → form posts → `admin/actions/contacts.ts` (`requireAdmin`
→ zod → service) → `revalidatePath("/admin/users")`.

**Autofill:** `/receipts/new` (server, `requireUser`) → `listContacts()` inside
the existing `Promise.all` → contacts passed to `ReceiptBuilderForm` →
`PartyFields role="receiver"` → `ContactCombobox` filters in memory via
`matchContacts` → on select, sets `name` upward and rank/unit/contact/email
locally → the form posts the same field names as today, so
`createReceiptAction` and its schema are **unchanged**.

## Out of scope

- Per-user private contact books (the book is shared org-wide).
- Autofill on the sender side (it already prefills from last-receiver).
- Saving a recipient to the book from the builder (admin-curated only).
- Server-side contact search, pagination, and fuzzy/typo-tolerant matching. At
  the stated scale (tens to a few hundred; ~500 contacts ≈ 75KB JSON) the whole
  book ships once and filters in memory. Revisit only past ~1–2k contacts, at
  which point `matchContacts` is the seam to move behind a server action.
- Importing contacts in bulk, and backfilling contacts from past `Transfer` rows.
