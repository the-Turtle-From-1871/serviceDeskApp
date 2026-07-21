# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/).

## 2026-07-21

### Changed
- **The `/items` list can now sort by audit status.** "Audit" is a new option in
  the Sort control. Most-urgent-first orders **Overdue → Due soon → OK → Never
  audited** (never-audited rows always trail the dated ones); click again to
  reverse. The sort is server-side over the whole inventory, riding a new
  denormalized `Item.lastAuditedAt` column (the derived audit *state* isn't
  stored, so it can't be an `ORDER BY` directly); the audit badge reads the same
  column, so sort and display always agree.
- **Audit signatures on the item page are hidden by default.** In the Audit
  history on an item's page (`/i/<id>`, already staff-only), each auditor's
  signature is now behind a **Show signature** button instead of shown inline —
  the auditor's name and date stay visible. The signature image is no longer
  shipped in the page payload at all; clicking Show fetches just that one image
  via a staff-gated action (`requireUser`). Any signed-in staff member can
  reveal it. The admin audit page and receipt signatures are unchanged.
- **Admin navigation consolidated into the Dashboard.** The admin header dropped
  from eight items to four (`Search · Items · Dashboard · Account`): the
  **Queue**, **Users**, and **Audit** sections and the **New item** action moved
  off the top nav into a **Manage** section on the Admin dashboard, which now
  serves as the admin hub. Those routes are unchanged and still directly
  reachable; the "Dashboard" link now stays highlighted across the whole admin
  area. USER and logged-out navigation are unchanged.
- **"Needs service?" is now DCSIM-recipient only.** On the hand-receipt builder,
  the per-item "Needs service?" control (the whole Service column) appears only
  when the recipient's "This side is DCSIM" box is checked — the service queue is
  for equipment coming in to the desk, not kit issued to an outside customer.
  Uncheck it and the column disappears (any in-progress selections are dropped).
  Enforced server-side too: `createReceiptAction` ignores any `service[...]`
  selections for a non-DCSIM recipient, so they can't be submitted out of band.
  Flagging service from the item detail page is unchanged.

## 2026-07-20

### Security
- **Supabase RLS / anon-key hardening.** Reinforced the deny-all posture for the
  `anon`/`authenticated` PostgREST roles (every table `RLS enabled, no policy`,
  new tables auto-enabled via the `rls_auto_enable` event trigger). The Data API
  and anon key stay unused — all authorization remains in the app layer over
  Prisma's privileged role.
- **Hardened auth surface.** Tightened the authenticated/authorized boundary on
  the auth flow; public-by-design endpoints (login, home search, receipt + item
  lookup) stay read-only and PII-minimal.
- **Item integrity.** Stronger server-side validation and integrity checks on
  item writes.

### Added
- **Cryptographically sealed asset handoff.** Every hand receipt is now sealed at
  creation with an Ed25519 signature over a canonical manifest of the handoff
  (receipt number, items, **both parties** — sender and recipient details +
  recipient signature — the acting technician (bound via an immutable
  `sealedByUserId` snapshot, not the nullable `createdByUserId` FK, so deleting
  the technician's account can't break the seal), and a server timestamp),
  stored on the receipt. Admins get a **Verify seal** button on
  the receipt page that re-derives the manifest and reports **Valid / Tampered /
  Unsealed / Can't-verify / Not-found** — making after-the-fact edits to a receipt
  detectable (non-repudiation). Sealing is best-effort: if the signing key isn't
  configured, receipts are still created, just unsealed.
- **App Router error boundaries.** `error.tsx` / not-found handling so runtime
  failures render a graceful boundary instead of a broken page.
- **CSV import size guard.** The item-import form now rejects files over 5 MB up
  front, before upload (the analyze→confirm flow uploads the file twice).
- **Print QR from the item page.** The individual item view page (`/i/<id>`)
  shows a **Print QR** button (logged-in users) that opens a printable QR-label
  **PDF** in the **same format as the items-list multi-select QR sheet** (QR code
  with the serial beneath), served from `/i/<id>/qr/pdf`. It uses a PDF rather
  than `window.print()` so it works on mobile too — iOS/WKWebView ignores
  `window.print()`, whereas a PDF opens in the native viewer (Share → Print /
  Save to Files) and prints on desktop. The QR itself stays publicly viewable;
  only the button (and the PDF route) are gated to signed-in users.

### Changed
- **Live search on `/items`.** The items search box now filters as you type —
  no more "Search" button/Enter-to-submit. Input is debounced ~300ms and
  navigates the existing server-paginated URL (`?q/sort/dir`), resetting to
  page 1 on every new query; `sort`/`dir` are preserved. The list itself is
  still fetched server-side per page (unchanged) — only the trigger for a
  search changed, mirroring the live search bar already used on the home page.
- **`/items` at scale.** The items list is server-side **paginated + sorted**
  (URL-driven `?page/sort/dir`); only the current page reaches the client. Hot
  `where`/`orderBy` columns are indexed.
- **Server-side contact type-ahead in the receipt builder.** The builder no
  longer ships the whole contact book to the browser; it now type-aheads against
  the server (`searchContactsAction`, token-AND over name/email/unit, debounced +
  race-guarded), so only the handful of rendered matches reach the client.
- **Faster public search.** The public serial-number and receipt-number searches
  are backed by **pg_trgm GIN indexes**, turning the per-keystroke `ILIKE '%…%'`
  full-table scans into index scans — same (case-insensitive) results, just
  faster.
- **Leaner item page.** Non-admin and anonymous item-page viewers no longer
  receive the ~96-row unit list; only admins, who alone can edit the home unit,
  need it.

### Removed
- **Per-row "QR" link on the items list.** Removed the admin per-row **QR**
  shortcut (to `/admin/items/<id>/qr`) from each row's actions on `/items`; the
  QR is still available from the item page (`/i/<id>`) and the multi-select
  **Print QR codes** sheet.
- **Admin single-item QR page.** Removed the now-orphaned `/admin/items/<id>/qr`
  page and its `/admin/items/<id>/qr/pdf` label route (nothing linked to them
  after the per-row shortcut was dropped). The item-page **Print QR** button
  (`/i/<id>/qr/pdf`, sheet-format label) supersedes them.

### Notes
- Database: adds the pg_trgm trigram **GIN indexes** on `Transfer.receiptNumber`
  and `Item.serialNumber` (applied to dev/test/prod). The citext `serialNumber`
  search casts `"serialNumber"::text ILIKE …` in a parameterized `$queryRaw` so
  it actually uses the trigram index.
- New env var **`SIGNING_PRIVATE_KEY`** (Ed25519 PKCS#8 PEM) signs receipt seals.
  Generate a keypair:
  `node -e "const {generateKeyPairSync}=require('crypto');const {privateKey,publicKey}=generateKeyPairSync('ed25519');console.log(privateKey.export({type:'pkcs8',format:'pem'}));console.log(publicKey.export({type:'spki',format:'pem'}))"`
  Set the private key in `.env.local` (one line, `\n`-escaped) for dev and in Vercel
  (multi-line, as-is) for prod — use separate keys. The public key for verification
  is derived from the private key at runtime, so there is no `SIGNING_PUBLIC_KEY`
  var; keep the public key only if you later want offline/external verification.
  Migration `20260720210000_transfer_crypto_seal` adds the `cryptoSignature` and
  `sealedAt` columns (nullable, additive — no backfill). Migration
  `20260721120000_transfer_sealed_by_user_id` adds `sealedByUserId` (nullable,
  additive — no backfill), an immutable snapshot of the acting technician's user
  id at seal time; the seal signs over this column instead of the SET-NULL
  `createdByUserId` FK.

## 2026-07-17

### Added
- **Hand-receipt return timers.** An admin can set (or clear) a return deadline
  on a hand receipt via a return-by days input; the deadline is editable after
  the fact from the receipt timer UI.
- **Service-desk SLA timers.** Per-service-type SLA defaults compute a service
  item's due date, with a per-item override on the builder (bounded 1..3650
  days). Reopening a service item restarts the SLA clock.
- **Admin dashboard.** New dashboard surfacing overdue and due-soon hand
  receipts and service items, reachable from a **Dashboard** link in the nav.
- **Overdue-alert sweeps.** Daily cron route runs overdue-alert sweeps for both
  hand receipts and service items (`dueAt` / `overdueAlertedAt` columns on
  `Transfer` and `ServiceQueueItem`).
- **Due column** on the service queue, with a sortable `DueBadge`.

### Fixed
- Audit light: lightened the green state so it's distinct from the grey dot.

## 2026-07-16

### Added
- **Annual audit feature.** Per-item audit status with an audit light on the
  items list and item page, an admin **Mark audited** control, and an audit
  history (`ItemAudit` table). Audit state is derived (display-only), never a
  server `ORDER BY`.
- **Scan-to-build.** A camera sheet decodes a QR code (self-hosted wasm) and
  adds the scanned item to an open hand receipt; the item id is parsed by path
  and resolved server-side. Changing the item list invalidates any signature.
- **Start a hand receipt from the item page.**

### Changed
- Relabeled the item **Current user** field to **Current user email** and
  renamed the underlying `currentUser` field to `currentUserEmail` for clarity.

### Fixed
- Excluded `/wasm/` from the auth proxy so the decode binary is publicly
  fetchable.
- Mobile: docked "Scan to add" at the bottom of the items section instead of
  floating; stopped iOS zooming when a text field is focused; custom dropdown
  chevron so the arrow isn't stranded.

### Removed
- Dead Vercel cron config (the 90-day purge runs from GitHub Actions).

## 2026-07-15

### Added
- **Shared contact book.** Admin-managed contact book (on the Users page) with a
  `ContactCombobox` type-ahead over name, email, and unit. The receipt builder
  autofills both the **recipient** and the **sender** from the book.
- **DCSIM recipient signature picker.** When the recipient is DCSIM, a saved
  named signature can be picked; the pick is resolved server-side.
- **Component tests** (`test:ui`, opt-in jsdom), which surfaced and fixed two
  production bugs.

### Changed
- **Reworked the mobile layer** and retired the starter palette.
- `PhoneInput` gained an optional controlled mode.

### Fixed
- Signatures: cleared stale ink, stopped losing names, and closed a privilege
  gap; a signature no longer names a holder for an already-returned item.
- Contacts: `Escape` drops the highlight (not just the list); the combobox no
  longer eats a deliberate Enter submit; the phone field clears between
  contacts; `deleteContactAction` no longer leaks raw errors in dev.
- Corrected the DCSIM-toggle change reporting and gated it on role.

## 2026-07-14

### Added
- **Home-unit auto-detection on item import.** When mass-importing items, each
  item's home unit is now derived from its device name — the device name is
  split on `-`/`_` and matched (case-insensitively, in any position) against a
  reference list of unit abbreviations. Example: `HI-DCSIM-LT-001` → `DCSIM`.
  Detection only fills the home unit when the CSV leaves it blank; an explicit
  value is always preserved.
- **Interactive, learn-as-you-go resolution.** Device names whose unit code
  isn't recognized appear in a resolve step during import: pick which segment is
  the unit code and give it a name once. The mapping is saved and then applied
  automatically to every other item sharing that code — in the same import and
  in all future imports.
- **`Unit` reference table**, seeded with the 71 HIARNG unit abbreviations.
- **Select-all on the items table.** A tri-state header checkbox (none / some /
  all) that operates only on selectable (active) rows; retired items have no
  checkbox and never count toward a selection.
- **Device-name search.** The items list search now matches device name in
  addition to make, model, and serial number.
- **Item-level service queue.** Items are flagged "Needs service?" per serial on
  the receipt builder or from the item detail page, each carrying a service type
  (Reimage / Repair / Other + `serviceNote`). The `/admin/queue` view lists one
  entry per item with search, service-type filter, sort, and toggleable columns.
  "Mark Completed" is reversible (`COMPLETED` is retained, reopenable to
  `PENDING`).
- **Editable item details + edit history.** Inline edit on the item details card
  with a unit picker; a `USER` may edit only current-holder email + position,
  admins edit the full set. Every change writes an `ItemEdit` diff atomically,
  shown as an edit-history section.
- **Named signatures.** Admin-only create/delete of owner-scoped named
  signatures, and a picker to choose the signing technician on a return.

### Changed
- **Item import is now a two-phase flow:** upload → *analyze* (reports what will
  import, what's auto-detected, and what needs a unit — writes nothing) →
  resolve unknowns → *confirm* (writes items in a single transaction). Nothing
  is saved until you confirm; unresolved device names still import, just with a
  blank home unit.
- **`User.email` is now case-insensitive** (`citext`).

### Fixed
- QR code page: a long item URL now wraps onto its own line on narrow screens
  instead of overflowing.
- Stopped admin-only item notes leaking to non-admins via RSC props.
- Gave the service-note input an accessible name.

### Notes
- Database: adds migration `20260714184046_add_unit_table`. In production the
  `Unit` table was created and seeded via `prisma/manual/2026-07-14_add_unit_table_prod.sql`
  (idempotent) rather than `db:seed`, to avoid touching the admin account.
- Additional migrations in this window add the `ServiceQueueItem`, `ItemEdit`,
  `Signature`, and `ItemAudit` tables and the `dueAt`/`overdueAlertedAt` timer
  columns on `Transfer` and `ServiceQueueItem`.
