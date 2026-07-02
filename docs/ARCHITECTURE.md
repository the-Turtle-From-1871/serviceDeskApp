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

Three core models (`prisma/schema.prisma`):

### User
`id, rank?, name, email (unique), unit?, contactNumber?, passwordHash, role (ADMIN|USER), isActive, timestamps`
- Passwords stored as bcrypt hashes (cost 12); never plaintext. Emails are normalized to lowercase.
- Accounts are **admin-provisioned only** — self-registration has been removed. `User` rows are operator/staff logins for the kiosk, not a record of every party who ever appears on a receipt.

### Item
`id, make, model, serialNumber, homeUnit?, notes?, status (ACTIVE|RETIRED), createdById, timestamps`
- No `currentHolderId`: the app is a single-device kiosk, not a custody-tracking system. "Who holds it now" is derived by reading the most recent `Transfer` for the item (`getLastReceiver`), used only to pre-fill the sender on `/new`.

### Transfer (the hand-receipt record)
`id, receiptNumber (unique, "HR-…"), itemId, itemSummary, senderIsDcsim, senderName, senderRank?, senderUnit?, senderContact?, senderEmail?, receiverIsDcsim, receiverName, receiverRank?, receiverUnit?, receiverContact?, receiverEmail?, receiverSignature, createdByUserId?, status (COMPLETED|VOID), createdAt`
- Both parties are **typed snapshots on the row**, not FKs to `User` — a `Transfer` fully describes who gave/received an item even if no account for them ever existed.
- Either party may be flagged `*IsDcsim`: a DCSIM party only needs a name (no rank/unit/contact/email). A non-DCSIM party must supply rank, name, unit, contact, and email — all of which print on the DA 2062.
- `receiverSignature` is required on every row; there is no sender signature and no pending/in-flight state — a `Transfer` is created already `COMPLETED` in one kiosk operation.

## Kiosk flow (single device, no custody tracking)

An authenticated operator (the shared DCSIM/admin account, or an admin-created
regular user) works the flow at `/new` entirely on one device:

1. Pick or create the `Item`, then type in **both** parties' details. The
   sender is pre-filled from the last-known receiver of that item (falling
   back to the logged-in non-admin operator, else empty). Either side can be
   toggled DCSIM, which collapses that party's fields to just a name.
2. The **recipient** signs on-screen (`SignaturePad`) — there is no sender
   signature step and nothing is left "pending"; the whole exchange is
   recorded in one transaction as a `COMPLETED` `Transfer` with a fresh
   `HR-…` receipt number.
3. A DA Form 2062 hand receipt is generated immediately
   (`modules/receipts/hand-receipt.ts`), showing both parties, the recipient's
   signature, and a QR code pointing at `receiptUrl` = `/receipts/<receiptNumber>`.
4. `sendReceiptEmails` (`modules/receipts/send-receipt-email.ts`) emails that
   same `receiptUrl` to any **non-DCSIM** party that has an email address,
   via a pluggable `EmailSender` (`lib/email`): Resend over `fetch` when
   `RESEND_API_KEY`/`EMAIL_FROM` are set, otherwise a logging stub
   (`[email:stub]`) so nothing breaks in dev. Send failures are logged and
   swallowed — they never roll back the completed transfer.

No login is required to **find** a receipt afterward: `/` is a public search
(by item serial number or receipt number) that links to `/receipts/<rn>`
(view) and `/receipts/<rn>/pdf` (download), both public routes.

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
