# Item-List Transfers + Self-Registration — Design

**Date:** 2026-07-02
**Status:** Approved (pending spec review)
**Builds on:** `2026-07-02-kiosk-hand-receipt-pivot-design.md` (the shipped kiosk pivot)

## Summary

Four post-launch changes requested after the kiosk pivot shipped:

1. **Move transfer initiation onto the item list.** Replace the standalone `/new`
   kiosk page with a shared items list (`/items`) where every logged-in user can
   start a transfer for an existing item; the two-party form becomes item-scoped
   at `/items/[id]/transfer`.
2. **Transfer-only for non-admins.** Any logged-in user can view the list and
   transfer items; only admins may log new items or edit/retire them.
3. **Re-enable self-registration.** A public "Create account" page makes a
   standard USER account, immediately active, so two non-admins can transfer
   between themselves. (Reverses the pivot's removal of self-registration.)
4. **Hand-receipt name line includes unit + contact, sized to fit.** The DA 2062
   FROM/TO line prints a non-DCSIM party as `RANK Name, Unit, Contact`, shrunk to
   fit within the FROM/TO box.

## Decisions (from brainstorming)

- Transfer entry point: **from the items list** (per-item "Transfer" button). The
  standalone `/new` page is **removed**.
- Item access: **transfer-only for non-admins**; logging/edit/retire stay
  admin-only.
- Self-registration: **self-serve, immediately active** USER accounts.
- Name-line separator: **commas** (`RANK Name, Unit, Contact`).

### Account model (clarified)

An account is required only to **log in and initiate** a transfer. The
**counterparty is always typed and never needs an account** — in every transfer.

- **DCSIM-involved transfer** (one party is DCSIM): run from the DCSIM/admin
  login; the non-admin party is simply typed. That non-admin party does **not**
  need an account.
- **Two non-DCSIM parties** (no DCSIM involved): the **initiator** needs a login,
  which is exactly what **self-registration** provides. The other non-DCSIM party
  is still just typed.

There is no enforcement of "who must register" — the app only requires *a* login
to reach the transfer form. Self-registration exists so a non-admin initiator has
one when DCSIM is not involved.

## Goals

- A logged-in user reaches an item list, picks an item, and completes a transfer
  with the existing two-party form (DCSIM toggles, typed parties, recipient
  signature).
- Non-admins can self-register and transfer existing items; they cannot log,
  edit, or retire items.
- The receipt's FROM/TO line shows rank, name, unit, and contact for non-DCSIM
  parties, fitting within the form box.

## Non-goals

- Non-admins logging new items (explicitly admin-only per the access decision).
- Any change to the public receipt search / PDF download surface.
- Approval workflow for new accounts (accounts are active on creation).

## Architecture

### A. Shared items list — `/items` (authed, all roles)

New route `src/app/items/page.tsx` (+ a small client search box, reusing the
existing list style). Server component: `requireUser()`, `listItems({search})`.
Renders a table of items (make, model, serial, status). Every row has a
**"Transfer"** link → `/items/[id]/transfer`. When the viewer is an **admin**,
the page also shows a **"＋ Log new item"** button (→ existing
`/admin/items/new`) and per-row **Edit** (→ existing `/admin/items/[id]/edit`)
and **Retire** (existing `toggleItemStatusAction`). Non-admins see neither.

The admin item-management pages (`/admin/items/new`, `/admin/items/[id]/edit`)
stay as-is (admin-only). The old admin list page `/admin/items` is repointed:
the admin nav "Items" link now targets `/items`; `/admin/items/page.tsx` is
removed (its management affordances move onto `/items` for admins).

### B. Item-scoped transfer — `/items/[id]/transfer` (authed, all roles)

New route `src/app/items/[id]/transfer/page.tsx`. Server component:
`requireUser()`, load the item (404 if missing; block if `RETIRED`), read the
logged-in user's DB row for operator pre-fill, and compute the **sender
pre-fill**: `getLastReceiver(itemId)` if the item has a prior completed transfer,
else the non-admin operator's own account, else empty (same precedence as the
pivot). Renders a trimmed `ItemTransferForm` (client) with the **item fixed**
(shown as a heading, no picker, no "log new item" branch) plus the existing
Sender/Recipient blocks, DCSIM toggles, and `SignaturePad`.

The server action `createTransferAction` is simplified: it no longer parses
`itemMode`/new-item fields or calls `createItem`. It takes `itemId` (from a
hidden field / the route), validates `transferSchema`, calls
`createTransfer({...parsed.data, createdByUserId})`, sends receipt emails, and
returns `{ receiptNumber }` / `{ error }`. `parseTransferForm` drops its
item-mode/new-item logic and reads a fixed `itemId`. `lookupLastHolderAction`
is no longer needed (the page pre-fetches the sender pre-fill server-side) and
is removed.

On success the form shows the receipt number with Download-PDF / View-receipt /
"Back to items" links.

### C. Self-registration — `/register` (public)

Restore the removed pieces, adapted to the new user fields:
- `registerSchema` in `users.schema.ts`: `rank?`, `name`, `unit?`,
  `contactNumber?`, `email`, `password` (min 8). Role is always USER.
- `registerUser(input)` in `users.service.ts`: creates an active USER account
  persisting `unit`/`contactNumber`.
- `registerAction` in `auth.ts`: validate, create, sign in, redirect to
  `/items`.
- `src/app/register/page.tsx`: client form (rank, name, unit, contact, email,
  password) using `useActionState(registerAction)`.
- `src/proxy.ts` matcher: add `register` to the public set (alongside `/`,
  `login`, `receipts/`).
- The login page links to `/register` ("Create account"); the register page
  links back to `/login`.

### D. Receipt PDF name line — `hand-receipt.ts`

`partyHeader(p)` for a non-DCSIM party returns the comma-joined
`RANK Name, Unit, Contact`, omitting any missing field
(e.g. `SGT Jane Soldier, A Co 1-1 IN, 808-555-0134`; if unit/contact absent,
just `RANK Name`). DCSIM stays `DCSIM · <name>`.

Because this line is longer than the box, when filling the FROM/TO AcroForm
fields: enable multiline and **shrink the font to fit** — set an explicit small
size (start ~9) and, if the measured string width exceeds the field width at
that size, reduce until it fits (or use pdf-lib auto-size `setFontSize(0)` with a
sane floor). The appended custody-record page keeps its full per-field breakdown
unchanged.

## Routing / navigation cleanup

- **Remove** `src/app/new/` (page + `NewTransferForm.tsx`) — replaced by
  `/items` + `/items/[id]/transfer`.
- **Post-login redirect** (`loginAction`) and the auth-aware header links (home
  page, item-scoped transfer page) point to **`/items`** instead of `/new`.
- Admin nav "Items" → `/items`. Remove `/admin/items/page.tsx`.

## Data model

No schema changes. Reuses existing `User.unit`/`contactNumber`, `Item`, and the
`Transfer` snapshot columns. `getLastReceiver`, `createTransfer`,
`listItems`, `getItem`, `createUser` are reused as-is (except `registerUser`
re-added).

## Error handling

- `/items/[id]/transfer`: unknown item → `notFound()`; retired item → render a
  disabled state / message (no form).
- `createTransferAction`: unchanged `TransferError` mapping; best-effort email
  (isolated try/catch, already in place).
- `registerAction`: duplicate email → friendly error; on auth error after
  create → "Account created — please sign in."

## Testing

- **Unit:** `registerSchema` (required/optional fields, USER role, email
  lowercased); `parseTransferForm` updated for the fixed-item shape (no
  item-mode); `partyHeader` comma format for non-DCSIM (with and without
  unit/contact) and DCSIM unchanged.
- **PDF:** `buildHandReceiptPdf` still returns valid bytes with the longer name
  line for the representative party cases.
- **Access:** the `/items` page shows management actions only for admins (a
  render/prop-level assertion where feasible).
- Update/remove tests tied to the deleted `/new` new-item flow and
  `lookupLastHolderAction`.

## Open risks

- Removing `/new` and `lookupLastHolderAction` touches the just-shipped login
  redirect and headers — must repoint them to `/items` in the same change to
  avoid dead links.
- "Transfer-only for users" means a peer transfer of a not-yet-logged item is
  blocked until an admin logs it — intended, but worth noting to operators.
