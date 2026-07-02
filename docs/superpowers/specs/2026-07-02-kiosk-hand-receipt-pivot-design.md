# Kiosk Hand-Receipt Pivot — Design

**Date:** 2026-07-02
**Status:** Approved (pending spec review)
**Supersedes key flows in:** `2026-06-30-hand-receipt-app-design.md`

## Summary

Pivot the app from an **account-per-person, two-device** custody-transfer model to a
**single-device kiosk** model. At the DCSIM service desk, one device runs the whole
transfer: an operator selects an item, types the sender's and receiver's details, the
recipient signs on-screen, and a hand receipt is generated immediately. Party details
are **typed fresh each time** and stored as snapshots on the transfer — the receiving
party no longer needs an account. The public gets a no-login page to search their hand
receipts by serial or receipt number and download the PDF.

## Goals

- One device completes a full custody transfer end-to-end (no second-device sign step).
- Either party can be marked **DCSIM** (the admin organization); the DCSIM technician
  always types their individual name and signs only when DCSIM is the recipient.
- Every **non-DCSIM** party supplies rank, name, unit, contact number, and email — all
  printed on the receipt.
- Non-DCSIM parties are emailed the same link that the receipt's QR code encodes.
- New items are logged with only: make, model, serial number, home unit, optional notes.
- Self-registration is removed; only the admin creates accounts.
- A public page lets anyone search receipts (by serial or receipt number) and download
  the PDF.

## Non-goals

- Migrating historical transfer/item data (early live app — see Migration).
- Multi-item receipts (still one item per receipt).
- Approval/pending workflow (transfers complete immediately on signature).

## Decisions (from brainstorming)

1. **Auth:** *All* transfer creation requires login. Two account kinds — the shared
   **DCSIM/admin** account (service desk) and **regular user** accounts (admin-created
   only). Public, no-login access is limited to receipt search + PDF download.
2. **Regular user is always a party.** A logged-in non-admin user is the sender or
   receiver on the receipt; their side pre-fills from their account. They type the
   counterparty freeform.
3. **Signature:** recipient only, always required. Sender never signs. If DCSIM is the
   recipient, the DCSIM technician signs.
4. **QR + email link** point to a public per-receipt page with a Download-PDF button.
5. **Holder:** no hard validation. The sender fields pre-fill (editable) from the item's
   most recent completed transfer's receiver snapshot.
6. **Party storage:** denormalized snapshot columns on `Transfer`; a nullable
   `createdByUserId` audit link to the logged-in initiator.
7. **Email provider:** Resend, behind a small pluggable interface (Brevo is the fallback
   if domain verification is undesirable).
8. **Migration:** keep the admin account; wipe all items, transfers, and non-admin users.

## Data model

### `Transfer` (reworked)

Replace the `fromUser`/`toUser` FK model with per-side snapshot columns.

| Column | Type | Notes |
|---|---|---|
| `id` | String cuid | PK |
| `receiptNumber` | String @unique | Human-facing `HR-XXXXXXXX`; searchable |
| `itemId` | String FK → Item | |
| `itemSummary` | String | `"<make> <model> (SN <serial>)"` snapshot |
| `senderIsDcsim` | Boolean | |
| `senderName` | String | Always required (tech name if DCSIM) |
| `senderRank` | String? | Required when not DCSIM |
| `senderUnit` | String? | Required when not DCSIM |
| `senderContact` | String? | Required when not DCSIM |
| `senderEmail` | String? | Required when not DCSIM |
| `receiverIsDcsim` | Boolean | |
| `receiverName` | String | Always required (tech name if DCSIM) |
| `receiverRank` | String? | Required when not DCSIM |
| `receiverUnit` | String? | Required when not DCSIM |
| `receiverContact` | String? | Required when not DCSIM |
| `receiverEmail` | String? | Required when not DCSIM |
| `receiverSignature` | String | PNG data URL; always required |
| `createdByUserId` | String? FK → User | Logged-in initiator; audit only |
| `status` | enum | `COMPLETED` \| `VOID` (admin void) |
| `createdAt` | DateTime | Also the "signed/effective" time |

Removed from the old model: `fromUserId`/`toUserId`/`fromUserName`/`toUserName`,
`isOverride`, `actingAdminId`, `signatureImage`, pending/accept/cancel machinery,
`initiatedAt`/`signedAt`/`cancelledAt` (collapsed to `createdAt`).

**Validation rules** (Zod, server-enforced):
- Exactly-one-party-DCSIM is *allowed* (sender OR receiver); **both DCSIM is rejected**
  (meaningless), as is neither-party being provided.
- DCSIM side: only `name` required.
- Non-DCSIM side: `rank`, `name`, `unit`, `contact`, `email` all required (email valid).
- `receiverSignature` must be a `data:image/png;base64,` URL under the existing size cap.

### `Item` (reduced)

| Column | Keep? | Notes |
|---|---|---|
| `make`, `model`, `serialNumber` | keep | |
| `homeUnit` | rename | was `homeLocation` |
| `notes` | keep | optional |
| `assetTag` | **drop** | |
| `homeLocation` | **rename → `homeUnit`** | |
| `currentHolderId` | **drop** | pre-fill derives from last transfer |
| `status` | keep as-is | ACTIVE/RETIRED retained for item lifecycle |

"Last-known holder" is derived: the receiver snapshot of the item's most recent
`COMPLETED` transfer. No holder column.

### `User` (extended, self-reg removed)

Add `unit` (String?) and `contactNumber` (String?) so a regular user's party side can
pre-fill fully. Keep `rank`, `name`, `email`, `passwordHash`, `role`, `isActive`.
`registerUser`/self-registration path is removed; accounts are created only via the
admin users page.

## Pages & routes

| Route | Access | Purpose |
|---|---|---|
| `/` | **public** | Receipt search (serial # or receipt #) → results → Download PDF |
| `/receipts/[receiptNumber]` | **public** | Single receipt view + Download PDF (QR/email target) |
| `/login` | public | Sign in (kept) |
| `/new` | auth | The kiosk transfer flow (see below) |
| `/admin/items...` | admin | Item management (reduced fields) |
| `/admin/users...` | admin | Create/manage accounts (only place accounts are made) |
| `/receipts/[receiptNumber]/pdf` | **public** | Streams the generated PDF (see Access note) |

**Removed routes/flows:** `/register`, `/dashboard`, `/i/[itemId]` acting UI,
two-device accept/sign (`/transfers/[id]` SignForm), per-user pending lists,
`InitiateTransferForm`, `OverrideForm` (replaced by the unified `/new` flow).

**PDF access note:** the public per-receipt page and its Download-PDF endpoint are
reachable by anyone holding the receipt number/URL (matches "publicly searchable +
downloadable"). Receipt numbers are non-sequential (cuid-derived) so they aren't
trivially enumerable.

## Transfer creation flow (`/new`, authed)

1. **Select item** — searchable picker over existing items, or **“Log new item”**
   inline (make, model, serial, home unit, notes?) → returns to the flow with it
   selected.
2. **Sender** — a "This side is DCSIM" toggle. If DCSIM: only a tech-name field. If
   not: rank/name/unit/contact/email fields, **pre-filled** from the item's last
   receiver snapshot (editable). If the logged-in user is a regular user and chose the
   sender side, pre-fill from their account instead.
3. **Receiver** — same DCSIM toggle + fields. If the logged-in regular user is the
   receiver, pre-fill from their account.
4. **Recipient signs** on-screen (existing `SignaturePad`). Always required.
5. **Submit** — server action validates, writes the `Transfer` (status `COMPLETED`,
   `receiptNumber` generated), stamps `createdByUserId`, generates the PDF on demand,
   sends the receipt-link email to each non-DCSIM party, and shows a confirmation with
   the receipt number, a QR, and a Download-PDF link.

Placement of the logged-in regular user (sender vs receiver) defaults to **sender**
with a toggle; a DCSIM/admin operator gets no auto-placement (they type both sides,
marking one as DCSIM as appropriate). Both-sides-DCSIM is blocked in the UI and server.

## Receipt PDF, QR & email

- **PDF:** keep the DA Form 2062 fill + appended custody-record page. Header FROM/TO use
  `"<rank> <name>"` (or `"DCSIM"` for the DCSIM side). The record page prints **both
  parties' full snapshot** (rank, name, unit, contact, email — or `DCSIM · <tech name>`
  for the DCSIM side), the receipt number, timestamps, and the recipient signature, and
  now **embeds a QR code** for `/receipts/[receiptNumber]`. `assetTag`/ARC-derived lines
  that referenced dropped fields are removed.
- **Email:** on completion, send each **non-DCSIM** party an email containing the
  `/receipts/[receiptNumber]` URL (identical to the QR). Implemented behind an
  `EmailSender` interface with a `ResendEmailSender` (prod) and a logging no-op stub
  (dev/test). Failure to send is logged and surfaced as a soft warning — it does **not**
  roll back the completed transfer.

## Public receipt search (`/`)

- Single input; server action queries by exact `receiptNumber` (`HR-…`, case-insensitive)
  OR `item.serialNumber` (returns all receipts for that serial, newest first).
- Results list item summary + parties (names/units) + date + Download-PDF link.
- No auth. No signature image shown inline (only in the downloaded PDF) to keep the
  public surface minimal.

## Migration & removals

- **Prisma migration:** add the new `Transfer`/`Item`/`User` columns, drop removed ones,
  rename `homeLocation`→`homeUnit`, add `Transfer.receiptNumber` unique. Because the
  party model changes shape, a data-preserving backfill isn't attempted.
- **Data:** a one-time step keeps the admin `User` (by role=ADMIN) and deletes all
  `Transfer`, `Item`, and non-admin `User` rows.
- **Code removals:** self-registration (`registerAction`, `registerUser`, `/register`,
  `registerSchema`), the accept/cancel/override transfer services and their actions,
  `/dashboard`, `/i` acting UI, `InitiateTransferForm`, `OverrideForm`, `TransferHistory`
  as a holder-facing widget (a read-only variant may be reused on the receipt page).

## Testing

- **Unit:** party validation (DCSIM vs non-DCSIM required fields; both-DCSIM rejected;
  signature required), receipt-number generation/uniqueness, pre-fill derivation from
  last transfer, item schema (reduced fields).
- **Service:** create-transfer writes correct snapshot + completes; search by serial and
  by receipt number; email sender invoked for non-DCSIM parties only.
- **PDF:** receipt builds with both-party details and QR for representative cases
  (non-DCSIM→non-DCSIM, DCSIM sender, DCSIM receiver).
- Update/remove obsolete tests for the deleted two-device flow.

## Open risks

- **Resend domain verification** on `turtolabs.com` must be completed before prod email
  works; until then the no-op stub logs links.
- **Public PDF exposure** relies on non-enumerable receipt numbers; acceptable per the
  "publicly searchable" requirement, but worth confirming no PII beyond what's intended
  on the receipt is exposed.
