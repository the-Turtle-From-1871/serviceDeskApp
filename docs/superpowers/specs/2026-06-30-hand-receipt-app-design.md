# Digital Hand Receipt App — Design

**Date:** 2026-06-30
**Status:** Approved (pending final spec review)

## Purpose

Digitize the process of passing items from one person to another. Replaces
paper hand receipts with an auditable, digital custody chain. Each item carries
a QR code; scanning it shows the item's details and its full transfer history,
and lets the current holder initiate a signed hand-off to another person.

## Users & Roles

Two roles, both authenticated with email + password (no open self-registration;
admins create accounts).

- **Admin**
  - Create/edit/retire items and generate their QR codes.
  - Manage user accounts (create, deactivate, set role).
  - Force-reassign / override an item's custody without the normal signature
    handshake (e.g., person left the org, lost item). Overrides are flagged and
    recorded in history.
  - View all items and the full audit trail across the org.
- **Standard User**
  - Hold items, send (initiate transfer of) items they currently hold, and sign
    to accept items transferred to them.
  - View only items they currently hold or have previously held, and the
    associated transfer history.

## Core Concepts

### Item
Fields:
- `make` (string, required)
- `model` (string, required)
- `serialNumber` (string, required)
- `assetTag` (string, optional) — internal inventory tag
- `homeLocation` (string, optional) — storage/home area
- `notes` (string, optional, free text)
- `status` — `ACTIVE` | `RETIRED`
- `currentHolderId` — FK to User (nullable, e.g., unassigned)
- `createdById` — FK to User (the admin who logged it)
- `createdAt`, `updatedAt`

Each item has a stable id used in its QR URL (`/i/<itemId>`).

### Transfer (the digital receipt)
An append-only custody record. One row per hand-off attempt.
- `id`
- `itemId` — FK to Item
- `fromUserId` — FK to User (releasing holder; null for the initial assignment)
- `toUserId` — FK to User (receiving holder)
- `status` — `PENDING` | `COMPLETED` | `CANCELLED`
- `isOverride` (bool) — true when an admin force-reassigned
- `actingAdminId` — FK to User (set when `isOverride`)
- `signatureImage` — stored PNG of the receiver's drawn signature (path or blob
  reference); null for overrides and pending transfers
- `initiatedAt`, `signedAt` (nullable), `cancelledAt` (nullable)
- Denormalized snapshot fields for immutable history: `fromUserName`,
  `toUserName`, `itemSummary` (make/model/serial at time of transfer)

The **transfer history** shown on an item page is simply that item's Transfer
rows ordered newest-first.

### User
- `id`, `name`, `email` (unique), `passwordHash` (bcrypt)
- `role` — `ADMIN` | `USER`
- `isActive` (bool)
- `createdAt`, `updatedAt`

## Key Flows

1. **Log an item (admin).** Admin fills the item form → item created → QR code
   encoding `/i/<itemId>` generated and downloadable/printable (PNG). Admin
   optionally sets the initial holder (recorded as an initial assignment
   Transfer with no `fromUser`).

2. **Scan QR → item detail (`/i/<itemId>`).**
   - **Unauthenticated scanner:** sees read-only item details (make, model,
     serial, asset tag, location, current holder) and full transfer history.
     No actions available.
   - **Authenticated user:** same details + history; if they are the current
     holder, an **Initiate Transfer** button is shown.

3. **Transfer handshake (holder sends, receiver signs).**
   - Current holder taps **Initiate Transfer**, selects a recipient (active
     user) → a `PENDING` Transfer is created.
   - Recipient sees it in their dashboard under "Pending — action needed."
   - Recipient opens the pending transfer, reviews item + parties, **draws a
     signature** on a canvas signature pad, and taps **Accept custody**.
   - On accept: Transfer → `COMPLETED`, `signedAt` + `signatureImage` set,
     `item.currentHolderId` moves to recipient, receipt locked into history.
   - The initiating holder may **cancel** while the transfer is still `PENDING`
     (→ `CANCELLED`, no custody change).

4. **Admin override.** Admin force-reassigns an item to a new holder without a
   receiver signature → a `COMPLETED` Transfer with `isOverride = true` and
   `actingAdminId` set, recorded in history. Used for departures, lost items,
   corrections. Admin can also edit item fields and retire items.

## Screens

- **Login** — email/password. No public sign-up.
- **User dashboard** — "Items I hold", "Pending — action needed" (incoming to
  sign; outgoing awaiting the other party), links to item detail/transfer.
- **Item detail** (`/i/<itemId>`) — details, current holder, transfer history,
  contextual actions (initiate transfer if holder; sign if pending recipient).
- **Transfer/sign screen** — review + signature pad + accept.
- **Admin console**
  - All items (searchable/filterable list).
  - Create item + generate/print QR.
  - Users management (create, deactivate, set role).
  - Full audit / transfer history view.

## Architecture & Stack

- **Framework:** Next.js (App Router) + TypeScript — one codebase for UI and
  server API (route handlers / server actions).
- **Database:** PostgreSQL via Prisma ORM. Chosen over SQLite because custody
  transfers are concurrent, accountability-critical writes.
- **Auth:** Auth.js (NextAuth) credentials provider; bcrypt password hashing;
  server-side sessions. Role checks enforced server-side on every mutating
  action and on data reads scoped to the user.
- **QR codes:** generated server-side with the `qrcode` library, encoding the
  absolute item URL; downloadable/printable PNG.
- **Signature capture:** HTML canvas signature pad on the client; exported PNG
  stored and referenced by the Transfer record.
- **Deployment:** self-hostable via Docker (app + Postgres), or a managed host
  (Railway/Vercel + managed Postgres). The QR base URL must be a reachable host
  so phones can open item links.

### Component boundaries
- **Auth module** — session, login, role guards.
- **Items module** — CRUD, QR generation, item detail data.
- **Transfers module** — initiate / cancel / accept (sign) / override; the only
  code path that mutates `currentHolderId`, so custody logic lives in one place.
- **Users/admin module** — account management.
- **UI** — dashboard, item detail, transfer/sign, admin console.

## Authorization Rules (server-enforced)

- Only admins: create/edit/retire items, generate QR, manage users, override,
  view all items/full audit.
- Initiate transfer: only the item's current holder.
- Cancel transfer: only the initiating holder (or admin), while `PENDING`.
- Accept/sign: only the transfer's `toUser`, while `PENDING`.
- Standard users may read only items they currently hold or have held.
- Unauthenticated `/i/<itemId>` is read-only (details + history), no actions.

## Error Handling & Edge Cases

- **Concurrent transfer:** an item may have at most one `PENDING` transfer at a
  time. Initiating a second is rejected while one is pending. Accept/cancel use
  a transactional check so custody moves exactly once.
- **Stale pending after override:** if an admin overrides an item that has a
  pending transfer, the pending transfer is auto-cancelled.
- **Deactivated users:** cannot log in, cannot be selected as transfer
  recipients; items they hold remain until reassigned (admin override path).
- **Retired items:** no new transfers; history remains viewable.
- **Signature required:** accept cannot complete without a captured signature.

## Testing Strategy

- **Unit:** transfers module custody logic (initiate/cancel/accept/override),
  authorization guards, single-pending-transfer invariant.
- **Integration:** full handshake happy path; cancel path; override path;
  unauthorized action attempts (wrong role / wrong user) are rejected.
- **E2E (Playwright):** admin logs item + QR; user scans, initiates; recipient
  signs and accepts; history reflects the completed receipt; unauthenticated
  scan shows read-only details.

## Out of Scope (YAGNI, for now)

- Item photos, category/type, condition rating, dollar value.
- Bulk import/export, reporting dashboards, email notifications.
- Open self-registration and SSO.
- Mobile native apps (responsive web only).
