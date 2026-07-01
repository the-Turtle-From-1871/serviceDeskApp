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
`id, rank?, name, email (unique), passwordHash, role (ADMIN|USER), isActive, timestamps`
- Passwords stored as bcrypt hashes (cost 12); never plaintext. Emails are normalized to lowercase.
- Users can self-register (USER role); admins can also create accounts and set roles.
- `rank` is captured separately from `name`; the pair is snapshotted as "RANK Name" onto transfers.

### Item
`id, make, model, serialNumber, assetTag?, homeLocation?, notes?, status (ACTIVE|RETIRED), currentHolderId?, createdById, timestamps`
- `currentHolderId` is the single source of truth for who holds an item.
- **Only the transfers module ever writes `currentHolderId`** — item create/edit cannot move custody.

### Transfer (the custody ledger)
`id, itemId, fromUserId?, toUserId, status (PENDING|COMPLETED|CANCELLED), isOverride, actingAdminId?, signatureImage?, fromUserName?, toUserName, itemSummary, initiatedAt, signedAt?, cancelledAt?`
- Denormalized `fromUserName` / `toUserName` / `itemSummary` snapshot the parties
  and item at transfer time, so history stays accurate even if records change.
- **Partial unique index `one_pending_transfer_per_item`** enforces at most one
  `PENDING` transfer per item at the database level.

## Custody lifecycle

```
                 assignInitialHolder (fromUser = null, COMPLETED, no signature)
Admin creates item ─────────────────────────────────────────────► item held
        │
        ▼
Holder initiateTransfer ──► PENDING ──► recipient acceptTransfer (draws signature)
                              │                     │
                              │                     ▼
                              │              COMPLETED, currentHolderId := recipient
                              │
                              ├─ holder/admin cancelTransfer ──► CANCELLED
                              │
                              └─ admin overrideAssign ──► cancels PENDING,
                                    COMPLETED (isOverride = true, no signature)

Admin can RETIRE / reactivate an item (blocks new transfers while RETIRED).
```

Invariants (enforced in `modules/transfers/transfers.service.ts` + DB):
- Custody moves **only** on `acceptTransfer` (with a validated signature) or `overrideAssign`.
- A signature is required to accept: must be a `data:image/png;base64,` payload under a size cap.
- Only the **recipient** can accept; only the **holder or an admin** can cancel.
- RETIRED items and inactive recipients are rejected.
- Concurrent initiates for the same item resolve to exactly one PENDING (fast-path check + the DB unique index; P2002 → `ALREADY_PENDING`).

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
  the custody domain (self-registration + admin provisioning, rank/role fields).

Switching to Supabase Auth would be a **rewrite** — migrate identities into
`auth.users`, move session handling to the Supabase SDK, and re-express role
checks as RLS policies + JWT claims — with no benefit for this app. The
database-host choice (Neon → Supabase) is orthogonal to the auth choice.

Supabase Auth would be the better pick for a different app: one wanting social
logins, magic links, phone/OTP, a hosted auth UI, or a client-heavy design built
around RLS. This app wants none of those.

## Documents (pdf-lib)

- **Item QR PDF** (`modules/receipts/qr-pdf.ts`) — a one-page item sheet with details and the QR code. Route: `/admin/items/[itemId]/qr/pdf` (admin only).
- **DA Form 2062 hand receipt** (`modules/receipts/hand-receipt.ts`) — fills the official form (FROM/TO/identifier, item row with U/I + quantities), draws the recipient's signature **vertically in the quantity column** with the date and black anti-tamper guard bars, then appends a custody-record page. Route: `/transfers/[id]/receipt` (parties or admin). The template is embedded as base64 so it bundles reliably on serverless.

## Time

All user-facing dates/times render in **Hawaii Standard Time** (`Pacific/Honolulu`,
UTC−10) via `lib/datetime.ts`. Timestamps are stored in **UTC**; only display
converts — so the data is correct regardless of where the server runs.

## Hosting topology

- **Vercel** runs the Next.js app (server components + serverless route handlers + the Node-runtime proxy). Git-integration deploys build on push.
- **Supabase** provides Postgres. The app uses the **transaction pooler** (port 6543, `pgbouncer=true`) at runtime; migrations use the **session/direct** connection (port 5432). See [`../DEPLOY.md`](../DEPLOY.md).
