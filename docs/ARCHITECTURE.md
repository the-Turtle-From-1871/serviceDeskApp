# Architecture

## Request flow

```
Browser
  │
  ▼
proxy.ts (Next 16 middleware, Node runtime)  ── anti-abuse, then a coarse
  │                                             gate: refuse non-browser and
  │                                             over-rate anonymous callers,
  │                                             PIN-gate the public PII surface
  │                                             (/i/*, /receipts/*, but NOT /),
  ▼                                             redirect the rest to /login
Server Component / Server Action / Route Handler   (excludes /login, /api/cron,
  │                                                static assets)
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
`id, make, model, serialNumber (unique, citext), homeUnit?, deviceUIC? (unit issued-to code, indexed), deviceCategory? (free-text device class — "Laptops", "Switches"; indexed), deviceName?, notes?, currentUserEmail?, currentPosition?, MDM telemetry (lastLogonUserPrincipalName?, lastLogonDate?, enrollmentDate?, compliance? — imported, read-only), status (ACTIVE|RETIRED), markedReadyAt? (the one hand-set readiness signal — see below), lastLogonAt? (the MDM `lastLogonDate` text parsed to an instant on import), lastAuditedAt? (denormalized audit recency — ALSO the accountability signal), createdById, timestamps`
- `serialNumber` is **`@unique @db.Citext`** — a device's case-insensitive identity (like `User.email`), so it can't be logged twice even with different casing; the CSV import dedups case-insensitively and relies on the DB constraint (`skipDuplicates`).
- No `currentHolderId`: "who holds it now" is derived. There are **two deliberately different rules**: `getHoldingTransfer`/`getLastReceiver` take the item's *latest* receipt and fail closed (no row, or any `returnedAt`, names nobody) because that value prefills a signed DA 2062, where naming the wrong holder is worse than naming none; the list/search/readiness surfaces use the looser shared predicate in `modules/transfers/custody.sql.ts` (any open receipt with an unreturned row). The two can differ when an item sits on an older open receipt and a newer closed one — do not unify them without deciding what the receipt builder should get. A standard `USER` may edit only `currentUserEmail` + `currentPosition` (`userItemDetailsSchema`); every other field is admin-only.
- The `/items` list is **server-side paginated + sorted** (`listItems`); only the current page reaches the client.
- **Operational readiness is DERIVED, never stored** (`modules/items/readiness.ts`). There is no readiness column: the state comes from the item's lifecycle status, a `PENDING` `ServiceQueueItem`, an open unreturned hand receipt, the MDM last-logon *user*, and `markedReadyAt` — the one signal a human sets ("it's back on my shelf"), a timestamp rather than a boolean so the marking can be compared to other dated signals and so "when did we last have hands on this" is answerable. `lastLogonAt` is the instant parsed on import from the verbatim `lastLogonDate` text; readiness no longer reads it (see below), but it is kept because the analytics surfaces do and because reinstating the rule that used it should not mean re-deriving how to parse the date.

### Transfer (the hand-receipt record)
`id, receiptNumber (unique, "HR-…"), itemSummary, lines (TransferLine → TransferItem, multi-item), senderIsDcsim, senderName, senderRank?, senderUnit?, senderContact?, senderEmail?, receiverIsDcsim, receiverName, receiverRank?, receiverUnit?, receiverContact?, receiverEmail?, receiverSignature, cryptoSignature?/sealedAt?/sealedByUserId? (the Ed25519 seal over the handoff manifest — see [`SECURITY.md`](./SECURITY.md)), createdByUserId?, status (OPEN|CLOSED), createdAt, closedAt?, purgeAfter?, dueAt?/overdueAlertedAt? (return timer)`
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
- **`Unit`** — the curated vocabulary of unit abbreviations, managed by admins at `/admin/units`. `abbreviation` is citext-unique and maps to a `fullName`. **Deliberately not a foreign key** on `Item.homeUnit`, which stays a plain, unindexed string: a CSV import must be able to carry a home unit the property book hasn't registered yet. Coherence is enforced in the service layer instead — deletion is refused while any item's `homeUnit` still matches the full name, and renaming a unit backfills every item carrying the old spelling (`renameUnit`). All three comparisons (the item-count column, the rename, the in-use check) match on `LOWER(btrim(...))`, so case and padding cannot make the UI and the delete disagree.
  **The CSV import is the source of truth for `homeUnit`, including on a MATCHED existing row** (`import.ts`): a matched row gets it exactly the way a new one does — the CSV's own column verbatim when supplied, else `detectHomeUnit(effectiveDeviceName, …)` — and it **overwrites** the stored value, logged to `ItemEdit` like `deviceName`/`deviceUIC`. Only a `detectHomeUnit`-derived value counts toward `detected`, and a row is `unresolved` only when it is *still* blank after both sources. A consequence worth stating: **`renameUnit`'s backfill is not permanent** — it fixes the fleet's spelling at that moment, but the next import carrying a `homeUnit` for one of those devices overwrites it again. The importer, not the vocabulary, has the last word.
- **`DeviceCategory`** — the curated vocabulary of device classes ("Laptops", "Switches"), managed by admins at `/admin/categories`. `name` is citext-unique. **Deliberately not a foreign key** on `Item.deviceCategory`, which stays a plain indexed string: a CSV import must be able to carry a category the property book hasn't registered yet, so an unknown category can never fail an import. Coherence is enforced in the service layer instead — deletion is refused while any item still carries the name, and imports register unseen names (`learnCategories`, mirroring `learnUnits`). The importer reads the category from a **`deviceType`** column (or `deviceCategory` / `category`); a bare `type` is deliberately not aliased, because MDM exports use it for OS strings.
- **`ImportBatch`** — an audit record of each CSV import (counts + skipped rows). `createdById` is a **required** FK, which is the entire reason the `mdm-import@service.invalid` service account exists (see CSV import below).
- **`PasswordResetToken`** — single-use, hashed, expiring self-serve reset tokens.
- **`PublicAccessSetting`** — the single-row (`id = "singleton"`) org config for the public-access PIN gate. Stores only the **bcrypt hash** of the 8-digit PIN, never the PIN; `updatedBy` is nullable + `SET NULL` so the row survives deletion of the admin who last set it.

## Creating a receipt (kiosk flow)

An authenticated operator works the flow at `/receipts/new` entirely on one
device. Each technician gets their **own** account — the acting account id is
recorded on returns and audits, so "who processed this" depends on logins not
being shared. (The one exception is `mdm-import@service.invalid`, which is
non-loginable; see CSV import below.)

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
   same `receiptUrl` — **one message, not one per party**. A **non-DCSIM**
   party is the customer and goes on the `To` line; the record copies
   (`RECEIPT_CC_EMAILS`, defaulting to the service-desk + army.mil archive
   addresses) and `ADMIN_INBOX_EMAIL` ride along as `Cc`. All three custody
   flows — new receipt, return, pickup — address themselves through the one
   module `lib/email-recipients.ts` (`addressCustodyEmail`), so "who saw
   this?" has a single answer. The trade is real and deliberate: one message
   is one delivery outcome, so a hard rejection can now cost every recipient
   the mail, where per-party sends only cost the bad address its copy.
   Send failures are logged and swallowed — they never roll back the created
   receipt.

   Transport is a pluggable `EmailSender` (`lib/email.ts`), selected by env
   presence only — never by falling back on a send failure, or an expired
   credential would silently reroute mail instead of surfacing:
   the **Gmail API** (OAuth2 refresh token, scope `gmail.send`) when the
   `GMAIL_*` vars are set, else Resend over `fetch` when
   `RESEND_API_KEY`/`EMAIL_FROM` are, else a logging stub (`[email:stub]`) so
   nothing breaks in dev. There is no SMTP path — `nodemailer` was removed.
   Any link in a custody email must be built from `defaultBaseUrl()`
   (`lib/base-url.ts`): a `vercel.app` URL in the body is enough to make the
   whole message vanish for `.mil` recipients, which is why `APP_URL` points
   at the custom domain.

No login is required to **find** a receipt afterward, but the data behind the
search is PIN-gated. `/` itself is **outside** the PIN gate — it is the page
that explains what this application is, and has to be readable by a logged-out
stranger (a redirect to `/unlock` fails Google's OAuth branding review). It
renders the explanation for everyone and the search box only once unlocked.
The gate did not move to the page, it moved to the **data**: a Server Action
POSTs to the path of the page hosting it, so `liveSearchAction`
(`app/actions/search.ts`) calls `publicAccessAllowed()`
(`lib/public-access-guard.ts`) itself, before the query — and **that call is
the entire gate on the public search**, not defence in depth. A refusal
returns `{ locked: true }`, never an empty result, because "No matches" would
be a confident wrong answer about the property book. The item and receipt
pages it links to — `/i/<id>`, `/receipts/<rn>` (view) and
`/receipts/<rn>/pdf` (download) — are still gated in `src/proxy.ts`. Both
paths route their decision through the same `shouldAllowPublic`, so the proxy
and the action cannot drift.

## Receipt lifecycle & returns

A receipt is not one-shot — it has a lifecycle driven by returns
(`modules/returns`, `modules/transfers/lifecycle.ts`):

- **`OPEN` → `CLOSED`.** A receipt is created `OPEN`. Equipment comes back through the **return** flow (`processReturnAction`, **admin-only**): the operator selects the serials being returned and signs. A **full** return (every held item back) flips the receipt to `CLOSED`; a **partial** return records the handback but leaves the receipt `OPEN` for the rest.
- **Immutable once closed.** `assertTransferOpen` guards every mutation — a `CLOSED` receipt (status `CLOSED` *or* a `closedAt` stamp) can never be reopened, edited, or returned against again.
- **Concurrency-safe.** `processReturn` runs one transaction that `SELECT … FOR UPDATE`s the `Transfer` row, then a compare-and-swap `updateMany` scoped to `returnedAt IS NULL` (asserting the affected count) — so two concurrent returns can't double-return an item or both decline to close.
- **Record + PDF.** Each return is a `ReturnTransaction` (kind, the tech's name/signature snapshot, returned serials). The DA 2062 renders one quantity/signature column (A–F) per partial return (`modules/receipts/render.ts`); the closing full return shows as the `CLOSED` watermark + "accepted by" attestation.

## Item-level service queue

Items needing work are tracked per-item (`ServiceQueueItem`, unique `itemId`; `modules/service-queue`):

- **Flagging.** An item is flagged "needs service" either per-serial on the receipt builder or from the item detail page, with a **service type** — `REIMAGE`, `REPAIR`, or `OTHER` (free-text `serviceNote`). The entry may carry the `transferId` it was flagged on. On the **builder** the whole Service column is offered only when the recipient is **DCSIM** — the queue is for kit coming *in* to the desk, not equipment issued to an outside customer — and that is enforced server-side as well as hidden in the UI: `createReceiptAction` drops any `service[...]` selections when `receiver.isDcsim` is false, so a crafted POST cannot enqueue. The item-page flag has no recipient and is unaffected.
- **State.** `PENDING` entries appear on `/admin/queue`; marking one done sets it `COMPLETED` (retained and reversible — reopenable to `PENDING` from the item page). All queue mutations are **admin-only**.
- **Completion deadline.** `dueAt` is optional and comes **only** from a days value a human typed — blank means *no deadline*, and there is **no per-service-type default** (the old REIMAGE 3d / REPAIR 7d / OTHER 5d table was removed: an invisible default produced overdue alerts for work nobody had dated). Setting or clearing a deadline on a live request is its own control on the item page (`setServiceDeadline`); editing a request's type or note leaves the stored deadline untouched. A **new round** — re-flagging or reopening a `COMPLETED` entry — always resets the deadline and the alert stamp rather than inheriting the finished round's. See `sla.ts` and the Service & Ticket Lifecycles section of `CLAUDE.md`.

## Timers & overdue alerts

Two independent deadlines, both built on `modules/timers/due.ts`:

- **Return timer** — an optional `Transfer.dueAt` for bringing items back.
- **Service SLA** — the `ServiceQueueItem.dueAt` above.

`dueState` classifies a deadline as `ontrack` / `soon` (within `DUE_SOON_DAYS` = 3) / `overdue`. The **admin dashboard** (`/admin`, `getTimerDashboard`) lists overdue + due-soon receipts and service items. A nightly sweep emails a **single** overdue alert per lapsed deadline to `ADMIN_INBOX_EMAIL`; `overdueAlertedAt` marks it sent so the same lapse is never emailed twice. It is re-armed only when the deadline is actually rewritten — via the receipt/service deadline controls, or when a service entry starts a new round — so editing a service item's type or note cannot re-alert an unchanged deadline.

## Retention & purge

- **Receipts:** closing a receipt stamps `purgeAfter = closedAt + 90 days` (`PURGE_WINDOW_DAYS`). The worker permanently deletes receipts past that deadline.
- **Accounts:** deactivating an account stamps `deactivatedAt`; accounts inactive **3+ months** are hard-deleted — but only when referentially safe. `Item.createdById` and `ImportBatch.createdById` are `ON DELETE RESTRICT`, so a user who logged items or ran an import is **skipped** (their history is preserved); `Transfer` / `ReturnTransaction` / `ItemEdit` FKs are `ON DELETE SET NULL` and detach, keeping a denormalized name snapshot for the record.

## Item audits & edit history

- **Audit status** (`modules/audit`) — items are audited annually (`AUDIT_PERIOD_YEARS` = 1). The item page shows a light derived from the newest `ItemAudit`: `compliant` / `overdue` / `never`. Recording an audit (admin) snapshots the auditing tech's name + signature.
- **Edit history** — every change to an item's loggable fields writes one `ItemEdit` (the field-level diff + editor name), surfaced on the item page and the admin audit log.
- **Audit recency is denormalized** onto `Item.lastAuditedAt` (maintained by `recordAudit`) so the fleet can be bucketed and ordered in SQL; the badge itself stays derived, and the SQL twin (`audit.sql.ts`) shares `auditCutoff` with the per-row `auditState` so the two cannot disagree about the boundary.
- **No readiness history** — there is nothing to record. Readiness is derived from live signals, so the only readiness write is the `markedReadyAt` stamp on the item itself. The former `ItemStatusHistory` snapshot table was dropped along with the stored status enum.

## CSV import (two front doors, one implementation)

The property book is kept current from the MDM/asset CSV export. There are **two
entry points and exactly one import implementation** — both call `commitImport`
(`modules/items/items.service.ts`); do not fork the logic:

- **`/admin/items/import`** — interactive and two-step: `analyzeImportAction`
  plans the import and reports rows whose home unit could not be decoded, an
  admin resolves those by hand, then `commitImportAction` applies it.
- **`POST /api/items/import`** — machine-driven, authenticated by a
  constant-time bearer compare against `MDM_IMPORT_SECRET` (checked *before* the
  body is read, so an unauthenticated flood costs one compare rather than a
  multi-megabyte read), with `resolutions: []`.

- **An empty `resolutions` array is valid, not a shortcut.** An unrecognised unit
  abbreviation never blocks a row: the item imports with a blank `homeUnit` and
  comes back in `unresolved` for an admin to teach the vocabulary later. Same
  reasoning as the categories/units "learn as you go" model — an unknown value
  must never fail an import.
- **The route's `maxDuration` must exceed `commitImport`'s transaction budget**
  (`maxWait` 5s + `timeout` 40s, consumed sequentially) *plus* the
  pre-transaction work in the same invocation — buffering the upload, the actor
  lookup, and the two parallel loads of up to `MAX_IMPORT_ROWS` (2000) rows.
  It is 60, which every Vercel plan accepts; an unsupported value is rejected at
  **deploy** time, and `next build` in CI cannot catch that. Too low and the
  platform kills the function mid-transaction instead of letting it abort into a
  caught error.
- **The `mdm-import@service.invalid` service account** is the one exception to
  "an individual account per technician". It exists solely because
  `ImportBatch.createdById` is a required FK and a machine-driven import has no
  session — `getImportActor()` **throws** rather than falling back to any other
  account, so a machine's mass edit can never be attributed to a real person.
  It is `isActive: false`, which is what makes it non-loginable, and its
  `deactivatedAt` stays NULL so the account purge worker never considers it.
- Matched rows are updated in place (not skipped as duplicates); changes to the
  logged fields land in `ItemEdit` exactly like a hand edit, and a `RETIRED` row
  is updated but writes no history.

## Operational readiness (derived)

`modules/items/readiness.ts` decides one row; `modules/items/readiness.sql.ts` is the SQL twin that buckets the whole fleet. Precedence, worst-evidence-last:

`RETIRED` (lifecycle) → `IN_REPAIR` (a `PENDING` `ServiceQueueItem`) → `DEPLOYED` (open unreturned receipt) → `READY_TO_DEPLOY` (`markedReadyAt` set) → `DEPLOYED` (has an MDM logon user) → `UNTRIAGED`.

- **The order is the design.** The service flag is checked *before* the receipt rule, which is what lets the receipt rule exist at all: a device turned in for repair while its receipt is still open must not read "Deployed". The MDM-logon rule is last of the two `DEPLOYED` rules because it is the weakest and stickiest evidence — it exists to cover the ~1,053 devices genuinely in soldiers' hands that predate the app and so carry no hand receipt.
- **A hand-set signal is beaten only by a deliberate act, never by telemetry.** A `DEPLOYED` rule reading `lastLogonAt > markedReadyAt` used to sit between the receipt rule and `READY_TO_DEPLOY`, making the marking self-expire; it was **removed from both twins**. A device on our own shelf produces logons routinely — imaging it, an MDM check-in, a test before reissue — so it read "Deployed" while physically in hand, contradicting the person who had just held it, and nightly automated imports made that a next-morning problem rather than a weekly one. What it uniquely caught was an issue-out with *no* hand receipt; a documented one is already covered. `lastLogonAt` is still parsed and stored, so reinstating it is a one-line change — in **both** twins, or `readiness.parity.test.ts` fails.
- **`markedReadyAt` is a timestamp, not a boolean.** Not for self-expiry any more, but so the marking can be *compared* to other dated signals and so "when did we last have hands on this" is answerable. It now persists until a deliberate act supersedes it: an open hand receipt, a service flag, retirement, or an explicit clear (`clearItemsReady`). `completeServiceItem` stamps it in the same transaction as the queue completion — the device is in hand at that moment. Asymmetry worth knowing: `markItemsReady` skips `RETIRED` rows, `clearItemsReady` does not, because clearing *retracts* an assertion.
- **Live custody is defined once, in SQL.** `modules/transfers/custody.sql.ts` (`CUSTODY_FROM` + `OPEN_CUSTODY_PREDICATE` = unreturned row on an `OPEN` receipt) is shared by the readiness CASE, the `/items` recipient search, and the Holder column, so no parity test has to police a third copy. It is deliberately *looser* than `getHoldingTransfer`, which takes the latest receipt and fails closed because its answer prefills a signed DA 2062.
- **Two implementations, one behaviour.** `readiness.parity.test.ts` runs one fixture table through both the TypeScript and the SQL and asserts they agree; changing the precedence in one fails that test until the other follows. Callers use `readinessForItems` (`readiness.query.ts`) for a bounded set of ids, or embed `READINESS_CASE`/`READINESS_JOINS` in an aggregate — never a third copy of the rule, and never a query per row.
- **Sortable in `/items` via a second query path.** Four signals across three tables means no column for a Prisma `orderBy`, but Postgres can still order it: when the sort includes `readiness`, `listItems` runs a parameterized `$queryRaw` that joins `READINESS_JOINS`, orders by `READINESS_RANK` (the CASE ranked in `READINESS_ORDER`, so the sequence is the operational one, not alphabetical) plus any other keys and the `id` tie-break, and returns just the page of **ids** for `getItemsByIds` to hydrate — two bounded queries, no per-row derivation. Every sort that does not mention a derived key takes the original Prisma path unchanged. Both paths implement the `?q=`/`?uic=` filter, so `items.readiness-sort.parity.test.ts` asserts they return the same ids in the same order for the same filters; sort keys reach the SQL only through the frozen `SORT_COLUMN` allowlist.
- **`auditState` is the OTHER derived key and takes the same raw path.** `DERIVED_SORT_KEYS` (`sort-keys.ts`) is the set of keys with no column — `readiness` and `auditState` — and `columnForKey` **refuses** them, so a caller that forgets to branch gets a typed error rather than a bad `ORDER BY`. `auditState` used to map to `lastAuditedAt`, which sorted by raw **recency** while the column displays a three-value **badge**; a timestamp is very nearly unique per row (production: 31 audited rows, 31 distinct stamps), so a secondary sort key had no ties to break and silently did nothing. It is now ranked by `auditRankSql` (`modules/audit/audit.sql.ts`) over `AUDIT_ORDER` — the same sequence the analytics donut stacks. Consequence: **the Audit sort orders by badge, not by recency**; within a badge, order comes from your secondary key, then `id`.
- **The `?q=` filter spans a relation.** Besides `deviceName`/`make`/`model`/`serialNumber`, it matches the **recipient named on the item's current open hand receipt** — the same `custody.sql.ts` rule the `DEPLOYED` badge uses, so search agrees with the badge beside it. That branch (and only that branch) splits the query into whitespace tokens and ANDs them, so "doe jane" finds "Jane Doe"; both query paths tokenize through the leaf module `recipient-search.ts`, because two tokenizers would drift exactly like two filters. On the Prisma side the relation is a nested `some`, on the raw side an `EXISTS` (`recipientMatchSql`).

## Readiness analytics (`/admin/analytics`)

Admin-only (`requireAdmin`, which re-reads role + `isActive` from the DB per request). Four widgets — audit readiness, fleet KPIs by category, DA 2062 volume, unit allocation.

- **State lives in the URL** (`?uic=&unit=&range=&groupBy=`). Changing a filter re-renders on the server and every widget re-queries, so there is exactly one filtering implementation and it is the SQL one. Views are shareable and bookmarkable.
- **Bounded by construction.** The page is a fixed number of queries — `groupBy` aggregation plus parameterized `$queryRaw` aggregates — and does not grow with fleet size. The two readiness widgets derive the state **in SQL** (`READINESS_CASE`), so the database buckets the fleet; rows are never fetched and classified in JavaScript.
- **There is no "fleet status over time" chart.** It was removed with the stored status enum and its history table: readiness is derived, so there is no timeline to plot, and reconstructing one from today's signals would only redraw today's answer across the x-axis. A real series needs a deliberate periodic snapshot of the derived state.
- **The unit leaderboard is deliberately NOT scoped by the global unit filter** — it is the control used to pick a unit, so it must keep listing every unit while one is selected. It uses two queries (top-N units, then their derived readiness breakdown) rather than one capped grouping, because capping a two-column grouping slices through the middle of a unit and under-reports its total.
- **`?groupBy` switches the leaderboard's GROUP BY column, not its labels** (`homeUnit` vs `deviceUIC`, default `unit`). The two are not 1:1 in the catalogue — of 44 distinct UICs only 18 have a single home-unit name, 20 map to several (one spans 46), 6 have none — and the `Unit` table cannot bridge them, since no item UIC matches any of its abbreviations. So there is no representative name per UIC to display; each dimension is its own partition with its own filter param (`?unit=` / `?uic=`), and the two params compose with AND (`itemWhere` / `itemScopeSql` are the single implementation of that scope). Blank and NULL values fold into one **Unassigned** row rather than being filtered out, so the Total column still sums to the fleet count in the header.
- **Volume counts items, not receipts** — a receipt can carry mixed categories, so per-category receipt counts would double-count and the stack would not sum to the total. It also cannot see past the 90-day receipt purge window; the UI says so.
- **Accountability is derived, not stored.** The audit-readiness donut buckets the fleet by audit recency (`lastAuditedAt`) into audited / overdue / never audited. There is no `isAccountedFor` column — one existed, defaulted to `true`, was written by almost nothing, and therefore reported a fully-accounted-for fleet out of the column default; it was dropped rather than left to overstate. The SQL bucket and the per-row badge share one period definition (`auditCutoff` / `auditState`), so the dashboard and the item list cannot disagree.
- **Colour is validated, not chosen by eye** (`admin/analytics/palette.ts`). The audit-readiness donut runs blue → yellow → red because any green/red pairing is indistinguishable under deuteranopia; the `/items` audit dots deliberately use a different (green/amber/slate) set, which passes as small dots beside a label but fails as adjacent wedges. Every chart ships a legend and a table view — the documented mitigation for palette slots under 3:1 contrast on the ledger surface.

## Background worker (cron)

`GET|POST /api/cron/purge` runs nightly maintenance in one hit, authenticated by a constant-time `CRON_SECRET` bearer check (no user session; **fails closed**): it purges expired receipts, purges eligible deactivated accounts, and sends the overdue return + service alerts. It runs from **GitHub Actions** (Vercel Hobby cron was unreliable) — see `.github/workflows/`.

## Authentication & authorization

- **Auth.js v5** (`next-auth`), **Credentials** provider, **JWT session strategy** (no DB session table).
- `authorize()` validates input (Zod), looks up the user, rejects missing/inactive accounts, and verifies the password with bcrypt.
- The JWT carries `id` + `role`, signed with `AUTH_SECRET`.
- **Session lifetime**: 10 hours absolute, 4 hours idle. `session.maxAge` alone
  would only be an idle bound (Auth.js re-signs the token on every `auth()`
  call), so the absolute bound is an `authAt` claim stamped once at sign-in;
  `lastActiveAt` carries the idle clock. Policy in `lib/session-freshness.ts`,
  *enforced* in the `jwt` callback so it covers Server Actions and RSC, not just
  proxy-matched routes — though the refreshed cookie is only *written* on the
  proxy path, which makes the matcher load-bearing. See
  [`SECURITY.md`](./SECURITY.md) §1.
- **Anti-abuse**: IP+account rate limiting, a global failed-login velocity
  detector, and an optional Cloudflare Turnstile challenge on the two
  unauthenticated forms. `lib/rate-limit.ts`, `lib/auth-velocity.ts`,
  `lib/turnstile.ts` — see [`SECURITY.md`](./SECURITY.md) §12–13.
- **Freshness**: `requireUser`/`requireAdmin` (via `defaultGetSession` in `lib/authz.ts`) re-read `role` and `isActive` from the DB on each protected request. A demoted admin or deactivated user is rejected on their next request — not when the token expires.
- **Self-lockout guards**: an admin cannot demote or deactivate their own account.
- Full control inventory (including the public PIN gate, password-reset hardening, the Ed25519 receipt seal, RLS posture, and CI security gates): [`SECURITY.md`](./SECURITY.md).

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
- **CI** (`.github/workflows/ci.yml`) runs **three** required checks, and `main` is branch-protected so a merge needs all three green (admins may bypass):
  - **`Semgrep SAST`** — runs from the official `semgrep/semgrep` docker image (a host `pipx` install breaks on the runner's Python 3.12); SARIF is informational, the blocking gate fails only on ERROR severity. Push + PR.
  - **`Build (next build)`** — push + PR.
  - **`Security docs current`** — `scripts/check-security-docs.mjs`, which fails a PR that touches a watched security file without touching `docs/SECURITY.md`. **PR-only**, because it diffs against the merge base, which is meaningless for a push to `main`; run it locally with `npm run check:security-docs`.

  Apply prod migrations **before** merging — Vercel's build never runs `migrate deploy`. See `CLAUDE.md` → CI/CD & Branch Protection.
