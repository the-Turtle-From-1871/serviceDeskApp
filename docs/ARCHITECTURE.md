# Architecture

## Request flow

```
Browser
  │
  ▼
proxy.ts (Next 16 middleware, Node runtime)  ── coarse gate: redirect
  │                                             unauthenticated users to /login
  ▼                                             (excludes /api/auth, /login,
Server Component / Server Action / Route Handler   /i/*, static assets)
  │
  ├─ requireUser() / requireAdmin()  ── real authz; re-reads role + isActive
  │                                     from the DB each request
  ▼
modules/*  (domain services)  ──►  Prisma (@prisma/adapter-pg → pg)  ──►  Postgres
```

Authorization is enforced in the **server functions**, not the proxy — the proxy
is only a coarse redirect gate. This follows Next's own guidance and keeps the
proxy edge-portable even though our app runs it on Node.

## Data model

The core models (`prisma/schema.prisma`) are `User`, `Item`, and `Transfer`, described below; the supporting models are summarized after them.

### User
`id, rank?, name, email (unique), unit?, contactNumber?, passwordHash, role (ADMIN|USER), isActive, timestamps`
- Passwords stored as bcrypt hashes (cost 12); never plaintext. Emails are normalized to lowercase.
- Accounts are **admin-provisioned only** — self-registration has been removed. `User` rows are operator/staff logins for the kiosk, not a record of every party who ever appears on a receipt.

### Item
`id, make, model, serialNumber (unique, citext), deviceName?, homeUnit?, currentUserEmail?, currentPosition?, notes?, status (ACTIVE|RETIRED), createdById, timestamps`
- `serialNumber` is **`@unique @db.Citext`** — a device's case-insensitive identity (like `User.email`), so it can't be logged twice even with different casing; the CSV import dedups case-insensitively and relies on the DB constraint (`skipDuplicates`).
- No `currentHolderId`: "who holds it now" is derived by reading the most recent `Transfer` for the item (`getLastReceiver`). A standard `USER` may edit only `currentUserEmail` + `currentPosition` (`userItemDetailsSchema`); every other field is admin-only.
- The `/items` list is **server-side paginated + sorted** (`listItems`); only the current page reaches the client.

### Transfer (the hand-receipt record)
`id, receiptNumber (unique, "HR-…"), itemSummary, lines (TransferLine → TransferItem, multi-item), senderIsDcsim, senderName, senderRank?, senderUnit?, senderContact?, senderEmail?, receiverIsDcsim, receiverName, receiverRank?, receiverUnit?, receiverContact?, receiverEmail?, receiverSignature, createdByUserId?, status (OPEN|CLOSED), createdAt, closedAt?, purgeAfter?, dueAt?/overdueAlertedAt? (return timer)`
- Both parties are **typed snapshots on the row**, not FKs to `User` — a `Transfer` fully describes who gave/received an item even if no account for them ever existed.
- Either party may be flagged `*IsDcsim`: a DCSIM party only needs a name (no rank/unit/contact/email). A non-DCSIM party must supply rank, name, unit, contact, and email — all of which print on the DA 2062.
- **Multi-item:** items are grouped into `TransferLine`s (per make/model), each holding `TransferItem`s (per serial). `receiverSignature` is required on every row.
- **Lifecycle:** a `Transfer` is created `OPEN`. A **full return** closes it (`CLOSED`, then immutable) and stamps `purgeAfter = closedAt + 90 days` — a cron worker hard-deletes receipts past that deadline. **Partial returns** leave it `OPEN` for the remaining items. Returns are recorded as `ReturnTransaction` rows (`modules/returns`); an optional `dueAt` return timer drives overdue email alerts.

> **Note — receipt enumeration was investigated, not shipped.** A `publicToken` (unguessable receipt URL) was prototyped to stop anonymous enumeration of receipts, then **reverted**: public, enumerable receipts + item pages are an **accepted team requirement** (see `CLAUDE.md`). The public receipt page/PDF stay reachable by the sequential `HR-…` number by design. Do not re-add token-gating or auth without a new decision.

### Supporting models

Beyond the three above:

- **`TransferLine` / `TransferItem`** — a receipt's items, grouped by make/model (line) down to each serial (item). `TransferItem.returnedAt` is the per-item handback marker.
- **`ReturnTransaction`** — one row per return event (`PARTIAL`|`FULL`) with the processing tech's name + signature snapshot and the JSON of returned serials.
- **`ServiceQueueItem`** — the per-item service-queue entry (unique `itemId`; `PENDING`|`COMPLETED`).
- **`ItemAudit` / `ItemEdit`** — annual-audit events and the field-level edit history for an item (nullable actor + denormalized name, so history survives account deletion).
- **`Signature`** — a named signature owned by an `ADMIN` (printed as the signer on the DA 2062); non-admins use the single `User.signatureImage`.
- **`Contact`** — a shared, org-wide address book for receipt autofill. The builder queries it through a **server-side type-ahead** (`searchContactsAction`, token-AND over name/email/unit) so the full book (outside people's PII) never ships to the client; admins manage the book. Any signed-in user can search; only admins write.
- **`Unit`** — maps a unit abbreviation to its full name; feeds CSV home-unit auto-detection.
- **`ImportBatch`** — an audit record of each CSV import (counts + skipped rows).
- **`PasswordResetToken`** — single-use, hashed, expiring self-serve reset tokens.

## Creating a receipt (kiosk flow)

An authenticated operator (the shared DCSIM/admin account, or an admin-created
regular user) works the flow at `/receipts/new` entirely on one device:

1. Pick or create the `Item`, then type in **both** parties' details. The
   sender is pre-filled from the last-known receiver of that item (falling
   back to the logged-in non-admin operator, else empty). Either side can be
   toggled DCSIM, which collapses that party's fields to just a name.
2. The **recipient** signs on-screen (`SignaturePad`) to accept custody — there
   is no separate sender-signature step. The exchange is recorded in one
   transaction as an `OPEN` `Transfer` with a fresh `HR-…` receipt number; it
   later moves to `CLOSED` when every item on it is returned (see Lifecycle).
3. A DA Form 2062 hand receipt is generated immediately
   (`modules/receipts/hand-receipt.ts`), showing both parties, the recipient's
   signature, and a QR code pointing at `receiptUrl` = `/receipts/<receiptNumber>`.
4. `sendReceiptEmails` (`modules/receipts/send-receipt-email.ts`) emails that
   same `receiptUrl` to any **non-DCSIM** party that has an email address,
   via a pluggable `EmailSender` (`lib/email`): Resend over `fetch` when
   `RESEND_API_KEY`/`EMAIL_FROM` are set, otherwise a logging stub
   (`[email:stub]`) so nothing breaks in dev. Send failures are logged and
   swallowed — they never roll back the created receipt.

No login is required to **find** a receipt afterward: `/` is a public search
(by item serial number or receipt number) that links to `/receipts/<rn>`
(view) and `/receipts/<rn>/pdf` (download), both public routes.

## Receipt lifecycle & returns

A receipt is not one-shot — it has a lifecycle driven by returns
(`modules/returns`, `modules/transfers/lifecycle.ts`):

- **`OPEN` → `CLOSED`.** A receipt is created `OPEN`. Equipment comes back through the **return** flow (`processReturnAction`, **admin-only**): the operator selects the serials being returned and signs. A **full** return (every held item back) flips the receipt to `CLOSED`; a **partial** return records the handback but leaves the receipt `OPEN` for the rest.
- **Immutable once closed.** `assertTransferOpen` guards every mutation — a `CLOSED` receipt (status `CLOSED` *or* a `closedAt` stamp) can never be reopened, edited, or returned against again.
- **Concurrency-safe.** `processReturn` runs one transaction that `SELECT … FOR UPDATE`s the `Transfer` row, then a compare-and-swap `updateMany` scoped to `returnedAt IS NULL` (asserting the affected count) — so two concurrent returns can't double-return an item or both decline to close.
- **Record + PDF.** Each return is a `ReturnTransaction` (kind, the tech's name/signature snapshot, returned serials). The DA 2062 renders one quantity/signature column (A–F) per partial return (`modules/receipts/render.ts`); the closing full return shows as the `CLOSED` watermark + "accepted by" attestation.

## Item-level service queue

Items needing work are tracked per-item (`ServiceQueueItem`, unique `itemId`; `modules/service-queue`):

- **Flagging.** An item is flagged "needs service" either per-serial on the receipt builder or from the item detail page, with a **service type** — `REIMAGE`, `REPAIR`, or `OTHER` (free-text `serviceNote`). The entry may carry the `transferId` it was flagged on.
- **State.** `PENDING` entries appear on `/admin/queue`; marking one done sets it `COMPLETED` (retained and reversible — reopenable to `PENDING` from the item page). All queue mutations are **admin-only**.
- **SLA timer.** Each entry gets a completion deadline (`dueAt`) defaulting by type — **REIMAGE 3d, REPAIR 7d, OTHER 5d** from when flagged (`sla.ts`), overridable per item.

## Timers & overdue alerts

Two independent deadlines, both built on `modules/timers/due.ts`:

- **Return timer** — an optional `Transfer.dueAt` for bringing items back.
- **Service SLA** — the `ServiceQueueItem.dueAt` above.

`dueState` classifies a deadline as `ontrack` / `soon` (within `DUE_SOON_DAYS` = 3) / `overdue`. The **admin dashboard** (`/admin`, `getTimerDashboard`) lists overdue + due-soon receipts and service items. A nightly sweep emails a **single** overdue alert per lapsed deadline to `ADMIN_INBOX_EMAIL`; `overdueAlertedAt` marks it sent so the same lapse is never emailed twice (editing the deadline forward clears it, re-arming a fresh alert).

## Retention & purge

- **Receipts:** closing a receipt stamps `purgeAfter = closedAt + 90 days` (`PURGE_WINDOW_DAYS`). The worker permanently deletes receipts past that deadline.
- **Accounts:** deactivating an account stamps `deactivatedAt`; accounts inactive **3+ months** are hard-deleted — but only when referentially safe. `Item.createdById` and `ImportBatch.createdById` are `ON DELETE RESTRICT`, so a user who logged items or ran an import is **skipped** (their history is preserved); `Transfer` / `ReturnTransaction` / `ItemEdit` FKs are `ON DELETE SET NULL` and detach, keeping a denormalized name snapshot for the record.

## Item audits & edit history

- **Audit status** (`modules/audit`) — items are audited annually (`AUDIT_PERIOD_YEARS` = 1). The item page shows a light derived from the newest `ItemAudit`: `compliant` / `overdue` / `never`. Recording an audit (admin) snapshots the auditing tech's name + signature.
- **Edit history** — every change to an item's loggable fields writes one `ItemEdit` (the field-level diff + editor name), surfaced on the item page and the admin audit log.

## Background worker (cron)

`GET|POST /api/cron/purge` runs nightly maintenance in one hit, authenticated by a constant-time `CRON_SECRET` bearer check (no user session; **fails closed**): it purges expired receipts, purges eligible deactivated accounts, and sends the overdue return + service alerts. It runs from **GitHub Actions** (Vercel Hobby cron was unreliable) — see `.github/workflows/`.

## Authentication & authorization

- **Auth.js v5** (`next-auth`), **Credentials** provider, **JWT session strategy** (no DB session table).
- `authorize()` validates input (Zod), looks up the user, rejects missing/inactive accounts, and verifies the password with bcrypt.
- The JWT carries `id` + `role`, signed with `AUTH_SECRET`.
- **Freshness**: `requireUser`/`requireAdmin` (via `defaultGetSession` in `lib/authz.ts`) re-read `role` and `isActive` from the DB on each protected request. A demoted admin or deactivated user is rejected on their next request — not when the token expires.
- **Self-lockout guards**: an admin cannot demote or deactivate their own account.

### Why Auth.js and not Supabase Auth

We use **Supabase only as a Postgres database** (through Prisma). Supabase Auth
(GoTrue) is a *separate* Supabase product and an **alternative** to Auth.js, not
a companion:

- Supabase Auth owns identities in its own `auth.users` schema, issues its own
  JWTs, expects the Supabase client SDK, and leans on **Row-Level Security** for
  authorization.
- Our app owns the `User` table (with `rank`, `role`, `isActive`, `passwordHash`)
  and enforces a role model in `requireUser`/`requireAdmin`, tightly coupled to
  the hand-receipt domain (admin-only provisioning, rank/role fields).

Switching to Supabase Auth would be a **rewrite** — migrate identities into
`auth.users`, move session handling to the Supabase SDK, and re-express role
checks as RLS policies + JWT claims — with no benefit for this app. The
database-host choice (Neon → Supabase) is orthogonal to the auth choice.

Supabase Auth would be the better pick for a different app: one wanting social
logins, magic links, phone/OTP, a hosted auth UI, or a client-heavy design built
around RLS. This app wants none of those.

## Documents (pdf-lib)

- **DA Form 2062 hand receipt** (`modules/receipts/hand-receipt.ts`) — fills the official form (FROM/TO/identifier, item row with U/I + quantities), draws the recipient's signature **vertically in the quantity column** with the date and black anti-tamper guard bars, embeds a QR code of `receiptUrl` (`/receipts/<receiptNumber>`, from `modules/items/qr.ts`), then appends a custody-record page. Route: `/receipts/[receiptNumber]/pdf` — **public, no login required**, since anyone with the receipt number or the QR link should be able to pull the PDF. The template is embedded as base64 so it bundles reliably on serverless.

## Time

All user-facing dates/times render in **Hawaii Standard Time** (`Pacific/Honolulu`,
UTC−10) via `lib/datetime.ts`. Timestamps are stored in **UTC**; only display
converts — so the data is correct regardless of where the server runs.

## Hosting topology

- **Vercel** runs the Next.js app (server components + serverless route handlers + the Node-runtime proxy). Git-integration deploys build on push.
- **Supabase** provides Postgres. The app uses the **transaction pooler** (port 6543, `pgbouncer=true`) at runtime; migrations use the **session/direct** connection (port 5432). See [`../DEPLOY.md`](../DEPLOY.md).
