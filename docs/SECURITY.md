# Security Features

A living inventory of every security control in this app — what it does, where
it lives, and why. **Maintained over time**; see [Keeping this current](#keeping-this-current).

**Last reviewed: 2026-08-04**

Related: [`ARCHITECTURE.md`](./ARCHITECTURE.md) · [`../CLAUDE.md`](../CLAUDE.md) · [`password-reset-hardening.md`](./password-reset-hardening.md)

---

## At a glance

| Area | Posture |
|---|---|
| Authentication | Auth.js v5, Credentials + JWT, bcrypt cost 12, live session revocation, 10h absolute / 4h idle |
| Authorization | Role-based (`ADMIN`/`USER`), enforced per-route, re-read from the DB every request |
| Public surface | Enumerable **by design**, behind a shared 8-digit PIN gate; `/` itself is open and carries no data |
| Secrets | All via env; sensitive modules marked `server-only` |
| Database | RLS deny-all, but **app-layer is the real boundary** |
| CI | Semgrep SAST + build + security-docs check, all three required to merge to `main` |
| Accountability | Receipts sealed + attributed; **server-attested, not user non-repudiation** |
| Rate limiting | Composite `(IP, email)`: 5 auth failures / 15 min under a 60 / IP ceiling; 300 requests / min anonymous; global botnet detector. **Live on Upstash Redis in prod since 2026-07-29** |
| Bot defence | Cloudflare Turnstile on login + reset (config-gated; **keys live in prod since 2026-07-29**); anonymous non-browser agents refused |
| Biggest gap | **No authentication event log, and most privileged mutations record no actor** — see [Known gaps #7](#known-gaps--accepted-risks) |

Jump to: [1 Authentication](#1-authentication) · [2 Authorization](#2-authorization) ·
[3 Public surface](#3-public-surface--the-pin-gate) · [4 Password reset](#4-password-reset) ·
[5 Injection](#5-injection--output-safety) · [6 Secrets](#6-secrets--data-leakage) ·
[7 Receipt seal](#7-cryptographic-receipt-seal) · [8 Cron](#8-background-jobs-cron) ·
[9 Retention](#9-data-retention--minimization) · [10 Database](#10-database-posture) ·
[11 CI/CD](#11-supply-chain--cicd) · [12 Rate limiting](#12-rate-limiting) ·
[13 CAPTCHA](#13-captcha--cloudflare-turnstile) · [Known gaps](#known-gaps--accepted-risks)

---

## 1. Authentication

**Stack** — Auth.js v5 with the Credentials provider and JWT sessions (no DB
session table). The token carries `id` + `role`, signed with `AUTH_SECRET`.
`src/auth.ts`

**Login is validated before anything expensive happens.** `credsSchema` (Zod)
trims and lowercases the email and rejects malformed input before the DB is
touched. `src/auth.ts`

**Passwords are bcrypt-hashed at cost 12.** The module is marked
`import "server-only"`, so hashing can never reach the client bundle.
`src/lib/password.ts`

**Inactive accounts cannot log in.** `!user.isActive` returns the same generic
failure as a wrong password. `src/auth.ts` → `authorize()`

**Login failures are always generic** — `"Invalid email or password."` never
reveals whether an address is registered. `src/app/actions/auth.ts` → `loginAction`

**A password change revokes existing sessions.** Every `auth()` call re-reads
`User.passwordChangedAt`; if the DB stamp is newer than the token's claim, the
`jwt` callback returns `null`, which clears the session cookies. Deleted accounts
revoke the same way. `src/auth.ts`

**Deactivation revokes the token too, not just the authz check.**
`setUserActive` stamps `passwordChangedAt` alongside `deactivatedAt` when an
account goes inactive, so the account's live JWT is revoked on its next request
via the path above. `src/modules/users/users.service.ts`

> Why it isn't enough to rely on `requireUser`: the `jwt` callback checks
> `passwordChangedAt` and account existence — **not `isActive`**. Authz was never
> the exposure (`src/lib/authz.ts` re-reads `isActive` every request, so a
> deactivated holder can neither read nor mutate), but the token still satisfied
> the coarse `!!req.auth` login check in `src/proxy.ts`, and with it the
> logged-in **bypass of the public PIN gate** ([§3](#3-public-surface--the-pin-gate))
> — for the JWT's full remaining life, up to the Auth.js default of 30 days.
> Reactivation deliberately does **not** clear the stamp: revocation only fires
> while the DB stamp is non-null, so clearing it would restore the tokens the
> deactivation just killed. The user signs in again instead. The column name is
> about passwords; its real meaning is "tokens issued before this instant are no
> longer trusted" — if a UI ever surfaces "password last changed", split it into
> a dedicated `sessionsRevokedAt` column rather than dropping the stamp.
> Accounts deactivated before this shipped keep their old session until it
> expires; deactivate + reactivate once to cut it off.

> Two deliberate softenings of that check: tokens issued *before* the claim
> existed are **seeded, not revoked**, and the DB read is wrapped in try/catch so
> a transient error returns the token unchanged rather than mass-logging-out
> users. Cost: one extra `SELECT` per authenticated request — the accepted price
> of keeping JWT sessions while supporting revocation.

**Sessions last one 10-hour workday, absolutely, and 4 hours idle.**
`src/lib/session-freshness.ts` + the `jwt` callback in `src/auth.ts`.
`session.maxAge` is 10 hours (down from the Auth.js default of **30 days**), but
that alone is only an idle bound: Auth.js JWT sessions ROLL — every `auth()` call
re-signs the token with a fresh `exp` and re-sets the cookie, so a tab left open
would never expire. The absolute bound is therefore an **`authAt`** claim stamped
at sign-in and never moved; a separate **`lastActiveAt`** claim moves on every
request and enforces the 4-hour idle cut-off. Either lapsing returns `null` from
the `jwt` callback, so the session stops satisfying `!!req.auth` and the coarse
gate in `src/proxy.ts` redirects to `/login` — i.e. it forces re-authentication.

> Why the callback and not the proxy: the callback runs on EVERY `auth()` call —
> Server Actions, Route Handlers and RSC included — not only the routes the
> proxy matcher covers. A proxy-only check would leave a 9-hour-idle session
> able to POST a Server Action.
>
> **But the WRITE rides the proxy, and that asymmetry is load-bearing.** Only
> the middleware/route-handler wrapper copies the session action's `Set-Cookie`
> onto the response (`handleAuth` in `next-auth/lib/index.js`); the bare
> `auth()` used by RSC and `requireUser` re-signs a token and discards it. So
> `lastActiveAt` advances because `src/proxy.ts` ran for the same request, which
> makes its **matcher** part of this control: excluding an authenticated route
> would leave users working there bounced 4 hours after their last *matched*
> request, with the whole unit suite still green. `tests/e2e/auth.spec.ts`
> asserts the cookie is re-issued across a navigation, because nothing else
> can see it.
>
> Same grandfathering softening as `pwdChangedAt`: a token minted before these
> claims existed is **backfilled, not revoked**, so the deploy that adds them
> does not sign every technician out at once. The backfill is dated from the
> token's own **`iat`**, never from `now`. That distinction is the whole of it:
> Auth.js JWTs are stateless with no revocation list, so writing a new cookie
> cannot invalidate the old string — dating from `now` would let a pre-deploy
> cookie saved out of devtools be re-pasted over and over, minting another full
> 10-hour session each time, until its own **30-day** expiry ran out. `iat` is
> re-stamped on every roll, so a live session backfills to moments ago (nobody
> is signed out) while a stale snapshot backfills to when it was last used and
> fails these bounds immediately. Each claim is backfilled independently, so a
> token carrying a real `authAt` never has its absolute clock restarted.
>
> A stamp in the *future* (clock skew between instances) is treated as fresh
> rather than expired — getting that backwards fails in the one direction that
> logs people out.

> **Knock-on, worth knowing:** a shorter session means staff land in the
> *logged-out* population more often, and the public surface treats them
> accordingly. A technician back from lunch who clicks a bookmarked `/i/<id>`
> now meets the recipient **PIN gate** ([§3](#3-public-surface--the-pin-gate)),
> not `/login` — `/unlock` carries a "Staff? Log in instead" link for exactly
> this — and that request spends the shared **anonymous** 300/min bucket
> ([§12](#12-rate-limiting)) keyed on the desk's single egress IP, rather than
> the signed-in exemption. Both are correct by design; both get more common as
> sessions get shorter.

**No public self-registration.** Removed by decision — accounts are provisioned
only by an admin (`createUserAction` / `createUser`). `registerSchema` is
retained unused for a possible future re-implementation.

**One account per technician** (policy, not code). Returns and audits record the
acting account id, so accountability depends on nobody sharing a login.

**Password policy** — minimum 8 characters, enforced by Zod on both admin
creation and self-service reset. `passwordField` in `src/modules/users/users.schema.ts`

---

## 2. Authorization

Authorization is **role-based** (`ADMIN` / `USER`), never ownership-based —
inventory, receipts, and the queue are shared org-wide.

**Every Server Action and Route Handler starts with `requireUser()` or
`requireAdmin()`** — never a bare `auth()`. Roughly 60 call sites. Throws a typed
`AuthError` (`UNAUTHENTICATED` / `FORBIDDEN`). `src/lib/authz.ts`

**Role and `isActive` are re-read from the DB on every protected request.** The
JWT only carries the role captured at login, so this is what makes a demotion or
deactivation take effect on the *next request* instead of at token expiry.
`src/lib/authz.ts` → `defaultGetSession`

**The authz module is `server-only`** — line 1 of `src/lib/authz.ts`.

**Field-level restriction is enforced server-side, not hidden in the UI.** A
`USER` may edit only an item's current-holder email and current position;
`deviceName` / `homeUnit` / `deviceUIC` / `notes` / `deviceCategory` are
admin-only. `updateItemDetailsAction` **picks the Zod schema by role**, so a
crafted POST can't widen the field set. Both edit surfaces (the item card and
`/admin/items/<id>/edit`) now share ONE field definition — `editableItemFields`
in `src/modules/items/items.schema.ts` — so the admin set cannot drift between
them; `userItemDetailsSchema` stays separately and deliberately narrow.

**Item identity (`make` / `model` / `serialNumber`) is a separate admin-only
action.** `itemIdentitySchema` → `updateItemIdentityAction`, reachable only from
the admin edit page. It is deliberately NOT part of `editableItemFields`, so
these three can never be reached from the item detail card or by a `USER` — an
ordinary edit POST carrying them is stripped by `z.object()`. Existing signed
hand receipts are NOT rewritten by a serial correction: `TransferItem.serialNumber`
is a snapshot taken at receipt creation and rendered as-is, so past receipts keep
the serial they were issued with. The form warns at the point of edit. A collision
on the citext-unique `serialNumber` surfaces as Prisma `P2002` and is returned as
a specific message; the Prisma detail is logged server-side only.

**Readiness edits live in their own admin-only actions** rather than being folded
into `updateItemDetailsAction` — that keeps the USER-editable field set exactly
as narrow as it was. `markItemsReadyAction` ("Mark as on hand",
`src/app/admin/actions/items.ts`) stamps `markedReadyAt` and nothing else.
`setReadinessAction` and `setItemsCategoryAction`
(`src/app/admin/actions/readiness.ts`) back the `/items` selection-bar controls
and the item page; both `requireAdmin()` first.

**Readiness is derived, so there is no stored state a POST could assert.** The
readiness selector writes only the underlying signals — `markedReadyAt` (set or
clear) and the `Item.status` lifecycle column. Its Zod target enum is an
allowlist of `READY_TO_DEPLOY` / `UNTRIAGED` / `RETIRED` / `ACTIVE`;
**`DEPLOYED` and `IN_REPAIR` are deliberately absent, so a crafted POST asking
for them is rejected rather than silently ignored.** Those two come from an open
unreturned hand receipt / MDM logon and from a `PENDING` `ServiceQueueItem`
respectively, and must stay unforgeable by hand. Widening that enum is a
security change, not a feature toggle — which is why the file is on the
`check-security-docs` watch list.

**Admin-only capabilities:** returns, user management, named signatures,
service-queue mutations, receipt timers, audits, analytics, category management.

**An admin cannot deactivate or demote themselves.** Both take effect live, so
either would revoke their own access. `src/app/admin/actions/users.ts:24,35`

**The proxy's login gate is a convenience, not the boundary.** `src/proxy.ts`
redirects unauthenticated requests for `/items`, `/admin/*`, `/account` to
`/login`, but real authz stays per-route.

> **Banned anti-pattern:** never gate a capability on "the user happens to own no
> rows" — a demoted admin keeps their rows. Check the **role**.

**One seeded, non-loginable account exists for machine-attributed writes: the
import service account.** `ImportBatch.createdById` is a required FK to `User`,
so an automated (cron-style, session-less) CSV import still needs a row to
attribute its `editor` to. `mdm-import@service.invalid` ("MDM Import
(automated)") is seeded by migration
`prisma/migrations/20260730000000_import_service_account/` and resolved by
`getImportActor()` in `src/modules/items/import-actor.ts`, which **throws**
rather than falling back to any other account if the row is ever missing —
attributing a machine's mass edit to a real person, silently, is worse than a
loud failure. Two independent things keep it non-loginable and un-purgeable:
- `isActive: false` is what blocks authentication — `defaultGetSession`
  (`src/lib/authz.ts`) returns `null` for an inactive user regardless of the
  password hash (which is a non-bcrypt sentinel string, not a real hash, since
  it never needs to compare true).
- `deactivatedAt` is seeded `NULL`, which keeps a freshly-migrated row out of
  `purgeDeactivatedUsers`'s scope (it only considers rows with a non-null
  `deactivatedAt`) — but that is a starting condition, not an enforced
  invariant. This row is an ordinary `User` to the rest of the app: nothing
  distinguishes it from a real technician's account in the admin Users list,
  and `toggleUserActiveAction` → `setUserActive(id, false)`
  (`src/modules/users/users.service.ts`) stamps `deactivatedAt` to `now` for
  ANY user it's pointed at, this one included. What's actually guaranteed is
  `hasBlockingReferences`: once this account has authored at least one
  `ImportBatch`, `purgeDeactivatedUsers` refuses to hard-delete it no matter
  what `deactivatedAt` holds (`ImportBatch.createdById` is
  `ON DELETE RESTRICT`). Until its first import runs — a fresh environment,
  or a row an admin deactivates before any import has happened — that
  protection has not yet attached, and the row is purgeable like any other
  deactivated account 3 months out.

The `.invalid` TLD (RFC 2606) guarantees the address can never collide with a
real person's. This is the **one deliberate exception** to "provision an
individual account per technician" — see the corresponding `CLAUDE.md` bullet.

---

## 3. Public surface & the PIN gate

> **Accepted requirement — do not "fix" this.** Logged-out recipients must be
> able to search, view, and download hand receipts by number/serial, and to
> search inventory and open item pages. Receipts are therefore enumerable
> (`HR-000001…`), and the public pages expose party PII, signatures, and the
> device catalog. This is intended. It can be hardened later *if the team asks*.

**An 8-digit shared PIN walls off `/i/*` and `/receipts/*`** when
`PUBLIC_ACCESS_PIN_ENABLED` is on. Logged-in users bypass it. This is a
**non-authz gate** — it checks a PIN cookie or a session; `requireUser` /
`requireAdmin` remain the real boundary. `src/proxy.ts`

**`/` is deliberately NOT in that list, and the gate it used to inherit moved to
the search action.** The home page must be readable by a logged-out stranger:
it is the page that states what this application is, and Google's OAuth branding
verification requires a publicly reachable home page that explains the app's
purpose — it refused this app because `/` redirected to the 8-digit PIN prompt.
Removing `/` from the gate exposes no data (the page renders only an
explanation, a link to `/unlock`, and — once unlocked — the search box; every
item and receipt page it leads to is still gated). **What it did expose is the
type-ahead Server Action**, because a Server Action POSTs to the path of the
page hosting it, so `liveSearchAction` was gated for free only while `/` was.
It now runs the identical check itself through `publicAccessAllowed()`, which
answers the same question from `shouldAllowPublic` — the shared decision
function — so "flag off = open" and "logged in = bypass" cannot come to mean two
different things on the two paths. **That check is the control, not defence in
depth:** delete it and the whole item and receipt catalog is searchable by
anyone who can POST to `/`, with no PIN. A refusal returns `{locked: true}`
rather than an empty result, so an expired cookie reads as "enter the PIN again"
instead of "your serial number does not exist". `/` remains inside gate 0b (the
anonymous browser check and the 300/min anti-scraping budget).
`src/lib/public-access-guard.ts`, `src/app/actions/search.ts`, covered by
`src/lib/public-access-guard.test.ts`, `src/app/actions/search.test.ts` and
`src/proxy.test.ts`

**The PIN is stored bcrypt-hashed, never plaintext.** Single-row
`PublicAccessSetting`, admin-settable from `/admin`, recording who changed it and
when. `src/lib/public-access.ts`

**The unlock cookie is HMAC-SHA-256 signed** — value is
`<expMs>.<hmac(AUTH_SECRET, expMs)>`, self-contained so the proxy verifies it
with no DB lookup. 12-hour TTL, `__Secure-` prefix over HTTPS.
`src/lib/public-access-cookie.ts`

**The TTL is a ceiling, not just a stamp** — `verifyUnlockValue` refuses a cookie
whose signed expiry is further out than `UNLOCK_TTL_MS` (plus a 60s
`UNLOCK_CLOCK_SKEW_MS` allowance, since signer and verifier are different
instances) from now, so shortening the TTL retires already-issued longer-lived
cookies instead of letting them run out their old window. It bites only while a
cookie claims more life than the current TTL — it is not a revocation lever, and
does not make PIN rotation retroactive (see Known gaps). `verifyUnlockValue()`

**A refused cookie is expired in the browser** — the proxy attaches a cookie
deletion to the `/unlock` redirect, so a cookie the ceiling retired is not
resent on every subsequent request until its own longer expiry. The deletion
spells out `secure`/`httpOnly`/`sameSite` explicitly: `cookies.delete(name)`
emits no `Secure` attribute, and a `Set-Cookie` whose name carries the
`__Secure-` prefix without it is rejected outright by browsers — which made the
deletion a silent no-op in production, the only environment that uses the
prefix. It fires only for a cookie whose signature verified as ours and which
is expired or over the ceiling — so a transient blank or mid-rotation
`AUTH_SECRET` cannot destroy every genuine cookie in the wild, and that outage
stays self-healing. **Known narrow race:** a slow request already carrying the
stale cookie can still land its expiry after the visitor unlocks in another
tab, clearing the fresh cookie and costing them one re-entry of the PIN. A
deletion names a cookie, not a value, so HTTP cannot express "only if it still
equals X"; accepted rather than papered over.
`src/proxy.ts`, covered by `src/proxy.test.ts`

**With no signing key the gate refuses cleanly** — `verifyUnlockValue()`
returns `{valid:false}` when the secret is empty and `signUnlockValue()` throws
a message naming the variable. This is **robustness, not a bypass fix**: Web
Crypto rejects a zero-length HMAC key (`DOMException: Zero-length key is not
supported`), so a blank `AUTH_SECRET` never produced `hmac("", exp)` — it threw
out of the proxy and 500'd every public page. The gate was already closed; it
is now closed without an outage. `src/lib/public-access-cookie.ts`

**A cookie is only retired if we signed it** — `verifyUnlockValue()` checks the
HMAC *before* the expiry and ceiling rules, and reports `retire` only for a
value that verified. Otherwise any anonymous visitor could trigger the
browser-side deletion and the ceiling warning by pasting arbitrary cookie text,
which is unauthenticated log amplification and makes the one signal that
distinguishes a clock-skew lockout from a wrong PIN spoofable.
`src/lib/public-access-cookie.ts`

**The signature compare is constant-time** — length-checked, no early exit, so it
leaks no timing information. `safeEqual()`

**The HMAC verify is skipped when it can't change the outcome** — it runs only
when the flag is on *and* the user isn't logged in. `src/proxy.ts` (the
`flagEnabled && !loggedIn` guard on the verify call — named rather than
line-numbered, since anchors rot on the first edit above them)

**The `?next=` redirect param is hardened against open redirects.**
`sanitizeNext()` rejects control characters (including tab/newline/CR),
backslashes, anything not starting with `/`, the protocol-relative `//host` and
`/\` forms, and self-redirects back to `/unlock`.

**Public endpoints stay read-only and PII-minimal** (login, home search, receipt
and item lookup) — never widen without explicit review.

---

## 4. Password reset

**Tokens are stored hashed, never raw.** 32 random bytes go out in the email; only
the SHA-256 hex is stored, so a DB leak can't be replayed.
`src/lib/reset-token.ts`

**One hour expiry, single use.** `EXPIRY_MS` in `src/lib/password-reset.ts`

**The token is claimed atomically** — a guarded
`updateMany({ where: { id, usedAt: null } })` compare-and-set runs *before*
hashing, so two concurrent requests with the same token can't both win. The loser
gets `count === 0` and bails. (This was a real TOCTOU fix, not a precaution.)

**A successful reset invalidates every other live link** for that user. Tokens
are deliberately **not** pre-invalidated at issue time — otherwise a failed email
send would strand the user by killing a link they already had.

**Deactivated accounts can't be reset** — `isActive` is re-checked before
`passwordHash` is mutated.

**Reset requests return in constant time.** The account lookup, token creation,
and email send are deferred via Next's `after()`; the action returns generic
success immediately, so response timing can't be used to enumerate accounts.
`src/app/actions/auth.ts`

**A 60-second per-account cooldown** throttles email-bombing of a known address.
`RESET_COOLDOWN_MS`

**No broken links are ever sent** — if no origin is configured, the send is
skipped with a server-side log rather than emailing a dead relative URL.

**The raw token is kept out of headers and history** — `Referrer-Policy:
no-referrer` on `/reset-password` and `/forgot-password` (`next.config.ts`), plus
`history.replaceState` scrubbing `?token=…` from the address bar on mount
(`ResetPasswordForm.tsx`). The hidden form field still carries it, so submission
is unaffected.

**Email and password are Zod-validated before hashing**, and email content is
HTML-escaped by `escapeHtml()` in `src/lib/email.ts` (which escapes `'` too).

> **Residual, accepted:** the initial `GET /reset-password?token=…` still reaches
> server/proxy access logs. Fully removing it needs a token→HttpOnly-cookie
> exchange with a redirect to a clean URL — intentionally deferred.
>
> **Also throttled per IP** — 5 reset requests and 5 failed reset submissions
> per 15 minutes, on top of the per-account cooldown. See
> [§12](#12-rate-limiting).

---

## 5. Injection & output safety

**All queries are parameterized** through standard Prisma methods. The raw
queries — `searchItemsBySerial` (citext/trigram cast), the two analytics
time-series, and the category in-use count — all use a parameterized
`$queryRaw`; string concatenation into SQL is banned outright.

**Outbound mail headers are hardened against injection.** `buildRawEmail` in
`src/lib/gmail-oauth-email.ts` strips CR/LF from every header value it writes —
`From`, `To`, `Cc`, `Subject`, and the attachment filename — before assembling
the RFC 2822 message. A header value may not contain a raw newline: it would
terminate the header and let caller-supplied text (a recipient name, a device
name) forge a new one, including an injected `Bcc`. A value carrying CR/LF is
collapsed to a space rather than rejected, so the message still sends with
visibly mangled — not silently altered — content.

**The one place an identifier is spliced into SQL is the `/items` `ORDER BY`,
and it is allowlisted twice.** A sort key arrives from the querystring and
becomes a column name in `derivedOrderedItemIds` — a value, not a bound
parameter, so it cannot be parameterized. `parseSortKeys` first drops anything
outside `ITEM_SORT_COLUMNS`, then `columnForKey` re-checks at the SQL boundary
with `Object.hasOwn(SORT_COLUMN, key)` — `hasOwn` and not a truthiness test,
because a plain object inherits `toString`/`constructor`, and a key of
`"toString"` would otherwise resolve to an inherited function and be spliced in.
The second check is the load-bearing one: it holds for any future caller that
builds sort keys some other way. Directions are never interpolated from input
either — `dir` is narrowed to the literal `ASC`/`DESC`.

**Derived sort keys have no column at all and are refused by `columnForKey`.**
`readiness` and `auditState` (`DERIVED_SORT_KEYS` in `sort-keys.ts`) order by a
ranked SQL `CASE` whose state names and ranks are **bound parameters**, so
nothing about them reaches the statement as text. A caller that forgets to
branch on them gets a typed `ItemError` rather than a malformed `ORDER BY`.
`sort-keys.ts` is on the `check-security-docs` watch list because adding a key
there widens what may be spliced; the `*.sql.ts` fragment files are not, because
they bind every value and splice nothing.

**Prisma's `mode: "insensitive"` is avoided for exact matches.** It compiles to
`ILIKE`, so `%` and `_` in the compared value act as WILDCARDS. The category
in-use check (which decides whether deleting a category is refused) uses
`LOWER(...) = LOWER($1)` instead, and `searchItemsBySerial` escapes `[\%_]`.

**CSV exports are guarded against spreadsheet formula injection.** Category and
device names originate from CSV *import*, i.e. from outside. A value starting
`=`, `+`, `-`, `@`, tab or CR is executed as a formula by Excel/Sheets, so
`toCsv` prefixes those with `'` (numbers exempted) on top of RFC 4180 quoting.
`src/app/admin/analytics/export.ts`

**There is no `dangerouslySetInnerHTML` anywhere in `src/`** (verified). React's
default escaping is the XSS defense; any future use needs explicit approval.

**Zod validates at every trust boundary** — Server Actions parse `FormData`
through a schema before use. `*.schema.ts` modules

**Every hidden UI control has a matching server-side check.** DCSIM-only controls
are hidden *and* rejected server-side, so a crafted POST can't enqueue service
items or fire a pickup notification for a non-DCSIM recipient.
`createReceiptAction`

---

## 6. Secrets & data leakage

**25 files carry `import "server-only"`** — including `authz.ts`, `password.ts`,
`crypto.ts`, `reset-token.ts`, `password-reset.ts`, `public-access.ts`, and (as
of 2026-07-31) `gmail-oauth-email.ts`. A client-side import of any of them
becomes a build error. `gmail-oauth-email.ts` qualifies the same way the others
do: every importer of `src/lib/email.ts` (which returns it from
`getEmailSender()`) is a Server Action, service, or route handler — never a
Client Component — so
marking it `server-only` costs nothing and keeps the OAuth client secret and
refresh token out of any client bundle by construction, not by convention.

**No hardcoded credentials.** Everything via `process.env`: `DATABASE_URL`,
`AUTH_SECRET`, `CRON_SECRET`, `MDM_IMPORT_SECRET`, `SIGNING_PRIVATE_KEY`,
`APP_URL`, `PUBLIC_ACCESS_PIN_ENABLED`, `ADMIN_INBOX_EMAIL`, `GMAIL_FROM`,
`GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`,
`TURNSTILE_SECRET_KEY`, `KV_REST_API_URL` / `KV_REST_API_TOKEN`.

**Outbound mail is sent via the Gmail API with an OAuth2 refresh token, not an
SMTP app password.** The SMTP transport (`GmailEmailSender`, selected by
`GMAIL_USER` + `GMAIL_APP_PASSWORD`) was removed on 2026-07-31; those two vars
no longer select any sender (`getEmailSender()` ignores them even if a stale
Vercel env still sets them — see `src/lib/email.test.ts`). The replacement,
`GmailOAuthSender` (`src/lib/gmail-oauth-email.ts`), authenticates with
`GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` / `GMAIL_REFRESH_TOKEN` — long-lived
credentials held only in Vercel environment variables, never in the repo — and
exchanges them for a short-lived access token per send (cached until near
expiry). The refresh token is scoped to `gmail.send` only: it can send mail as
the account but cannot read the mailbox, list messages, or access any other
Google data. Selection in `getEmailSender()` is by **env presence only** — Gmail
OAuth is chosen whenever all four `GMAIL_*` vars are set, in preference to
Resend, with no fallback to another transport if a send later fails. A dead or
expired refresh token therefore surfaces as a thrown error on every send
attempt rather than silently rerouting mail through Resend or the log stub; see
[Known gaps #9](#known-gaps--accepted-risks) for why that refresh token expires
on a roughly weekly cadence and how it's kept current.

**The `nodemailer` dependency is gone too, as of 2026-08-04.** The SMTP *code*
went on 2026-07-31; the package was kept a little longer as a rollback route and
nothing imported it in the interim. Removing it closes a tracked advisory
covering SMTP command injection and CRLF header injection — closed by deleting
the code path rather than upgrading it, so that class of bug cannot return
through this dependency. `npm ls nodemailer` is the check; the app has no SMTP
client at all now, and re-adding one would reopen both the advisory and the
app-password credential the OAuth sender replaced.

**The signing key is never logged** — failure paths in `src/lib/crypto.ts` log
the error, never the key.

**Queries `select` only the columns the view renders.** Signature blobs and PII
must never enter list, search, or type-ahead queries.

**Clients get generic errors; servers get the stack trace.** e.g.
`"Something went wrong. Please try again."` to the user, full `console.error`
server-side.

### Who is copied on custody email (`src/lib/email-recipients.ts`)

Every custody email — new hand receipt, return, pickup — is now **one message**
addressed to the customer and copying a fixed set of record addresses. That
message carries party names, contact details and the **signed hand-receipt PDF**,
so the CC list is a PII disclosure surface, not formatting.

**The record copies ship as defaults in code**, not as required configuration:
`dcsimservicedesk@gmail.com` (the sending account) and
`ng.hi.hiarng.mbx.dcsim-hand-receipt@army.mil`. `RECEIPT_CC_EMAILS` overrides
them; an **empty** value disables them, which is deliberately distinct from unset
(unset means "use the defaults"). Because the defaults are real addresses baked
into the source, editing that list changes who receives receipt PII with no
config change and no deploy-time signal — which is why the file is on the
`check-security-docs` watch list.

**Recipients can see each other.** CC is not BCC: every party on a receipt learns
the other addresses on it. That is intended here (the parties are named on the
document itself) but it is a change from the previous behaviour, where each
recipient got a separate message and could not see the others.

**One message means one delivery outcome.** Previously a bad address cost only
that recipient their copy. Now a hard rejection can cost everyone the message.
Sends remain best-effort and swallowed for receipts and returns so a mail failure
never rolls back a committed custody change; the pickup notice still throws so
the operator who triggered it is told.

**Links in these messages must come from `defaultBaseUrl()`, never a hardcoded
deploy URL.** Mail to `army.mil` was being silently dropped, and the cause was the
`vercel.app` URL in the message body, not authentication: a controlled four-message
test showed plain text, a `dcsim.us` link and a PDF attachment all delivered, while
only the message containing a `vercel.app` URL vanished. The government network
filters that domain, with no bounce and no signal. `APP_URL` now points at
`https://www.dcsim.us`, and a single hardcoded deploy URL in a body would silently
reintroduce the failure for every `.mil` recipient.

### Workstation-held deploy credentials (`scripts/gmail-token-rotation/`)

Local Windows tooling that rotates the Gmail OAuth refresh token and pushes it to
Vercel production. It is **not** part of the deployed app and runs on one
technician workstation, but it holds credentials that can write production.

**What it stores, and where.** `%LOCALAPPDATA%\dcsim-gmail-rotation\config.xml`,
written with `Export-CliXml`. The OAuth client secret, the Vercel API token and
the deploy hook URL are held as `SecureString`, so DPAPI encrypts them bound to
that Windows user on that machine — the file is inert if copied elsewhere. The
tool additionally attempts to strip inherited ACEs from the file, but that is
best-effort: a failure is logged as a warning and does not abort, so DPAPI is
the control being relied on, not the ACL. Nothing is stored in the
repository, and `state.json` / `rotate.log` are asserted secret-free: error
bodies from Google and Vercel are scrubbed of the token value, the bearer token
and the full hook URL before they reach a log line or a thrown message.

**The Vercel API token is project-scoped.** Vercel offers three scoping levels —
Full Account, Team, and Project — and this tool uses a **Project**-scoped token,
which denies any request to another project, to a team-level resource, or to a
user-level resource. A leak of this token therefore exposes one project's
environment variables and deployments, not the account. Create it at
`vercel.com/account/tokens`, selecting the individual project rather than "All
Projects" (which produces a team-scoped token instead).

Because Vercel infers team and project from a scoped token, `VercelTeamId` is
left null in the config and no `teamId` parameter is sent.

**The token expires.** Vercel does not offer a non-expiring token; the longest
available expiry applies. That is a second, annual renewal on top of the 7-day
one — noted in Known gaps rather than hidden, because when it lapses the
symptom is a 403 from the Vercel call and a failed rotation, not a mail outage.

**It can deploy production unattended.** A successful rotation writes
`GMAIL_REFRESH_TOKEN` and fires a deploy hook, so `main` ships without a human
present. The repo's migrate-before-push rule assumes the opposite; see `DEPLOY.md`.

**Execution trigger.** `HKCU\Software\Classes\dcsim-gmail-rotate` lets the toast
notification launch a rotation. The registered command is fully literal — an
absolute `powershell.exe`, an absolute quoted script path, `-File` last — and
`%1` is deliberately omitted, so no caller-supplied text reaches the command
line and a stray positional would fail parameter binding rather than execute.
Any same-user process could already run the script directly, so no trust
boundary is crossed. Nothing in the tool requires or acquires elevation.

**The consent click is not automated and must not be.** Driving a browser
through Google sign-in would require the account password and a 2FA bypass on
disk, and breaches Google's ToS.

---

## 7. Cryptographic receipt seal

**Each receipt manifest is Ed25519-signed.** `generateCryptographicSeal` /
`verifyCryptographicSeal` in `src/lib/crypto.ts`

**The signed bytes are deterministic.** `canonicalize()` recursively sorts object
keys so the same manifest always produces the same signature; callers pre-sort
arrays whose order isn't already fixed.

**The public key is derived from the private key** (`createPublicKey`) — no
second env var that could drift out of sync.

**Signing fails soft; verification fails loud.** A missing key logs and stores the
receipt *unsealed* rather than blocking a handoff, but verification throws
`CryptoKeyUnavailableError` — so "can't verify" is never silently reported as
"verified". Genuine tampering returns `false`.

**The acting technician's id is inside the signed bytes.** The manifest binds
`sealedByUserId` (`src/modules/transfers/seal.ts`) — deliberately the immutable
plain-text snapshot rather than the `ON DELETE SET NULL` `createdByUserId` FK, so
deleting the technician's account cannot turn an intact receipt into a false
TAMPERED.

**What the seal proves — and what it does not.** The private key is a single
app-wide `SIGNING_PRIVATE_KEY`; no key material is held by the technician. So the
seal is **tamper evidence plus an attribution claim**, not a signature *by* the
named person: it proves *a process holding the app's key asserted that user X
created this receipt, and the record is unaltered since*. It does not prove X
consented, because anyone holding the key can mint a valid seal naming any
`sealedByUserId`. Describe it as "tamper-evident and attributed", not as
user-level non-repudiation — see
[Known gaps #6](#known-gaps--accepted-risks).

---

## 8. Background jobs (cron)

**The purge endpoint authenticates with a shared secret** —
`Authorization: Bearer <CRON_SECRET>`. `src/app/api/cron/purge/route.ts`

**The check is a shared helper, not inline per-route logic** —
`hasValidBearerSecret` in `src/lib/cron-auth.ts`. It has no `server-only` and no
Prisma import, so it stays importable from any session-less route (the purge
cron today; a machine-driven MDM import route is the next consumer) without
those routes drifting into two independent copies of one auth check.

**The comparison is constant-time** (`timingSafeEqual`), with a length check
first so a mismatched length is rejected without comparing, and it compares
the WHOLE header including the `Bearer ` prefix so a caller cannot pass the
bare secret.

**It fails closed** — an unconfigured (or blank) `CRON_SECRET` rejects
everything rather than leaving the endpoint open.

**Never cached, Node runtime** (`dynamic = "force-dynamic"`) — it mutates data
and must run fresh on every invocation.

**Errors don't leak internals** — generic `"Purge failed"` plus a server log.

### The automated MDM import

**`POST /api/items/import`** — `src/app/api/items/import/route.ts` — is the
machine-driven consumer `hasValidBearerSecret` was already anticipating above.
It lets a nightly Intune/MDM export job POST its CSV in with nobody present.

**Same shared-secret pattern as the purge cron**, a different variable —
`Authorization: Bearer <MDM_IMPORT_SECRET>`, checked with the same
`hasValidBearerSecret` constant-time compare, and checked **before the request
body is read**, so an unauthenticated flood costs one comparison rather than a
multi-megabyte parse. **It fails closed**: an unset or blank
`MDM_IMPORT_SECRET` rejects every request.

**It writes as the service account, never as a person.** `getImportActor()`
(`src/modules/items/import-actor.ts`) resolves the seeded, non-loginable
`mdm-import@service.invalid` user (migration `20260730000000_import_service_account`;
`isActive: false` keeps it unable to sign in) and every `ItemEdit`/`ImportBatch`
row the run produces is attributed to it. If that account is missing,
`getImportActor` throws rather than silently attributing the import to
whichever admin happens to be first in the table.

**Rotating the secret needs a redeploy, not just an env change** — the same
non-negotiable as `NEXT_PUBLIC_TURNSTILE_SITE_KEY` (§13): the handler reads
`process.env.MDM_IMPORT_SECRET` from the running instance, so updating it in
Vercel without redeploying leaves the live instance checking the old value
while the scheduled job now sends the new one, and every run 401s until the
mismatch is caught.

**Reuses the one import implementation.** It calls the same `commitImport`
the interactive `/admin/items/import` page calls, with `resolutions: []` — an
unrecognised unit abbreviation does not block a row, it imports with a blank
`homeUnit` and comes back in the response's `unresolved` list. See
[§2](#2-authorization) / CLAUDE.md for why there are two front doors and one
implementation.

**Proxy exclusion, not an authz bypass.** `src/proxy.ts`'s matcher excludes
`api/items/import` by exact segment (not the `api/items` namespace) so the
route's own session-less request isn't redirected to `/login` by the coarse
login gate before the handler can even read the `Authorization` header — same
reasoning as the `api/cron` exclusion above. Real authorization is the bearer
check inside the handler, not the proxy.

**Declares `maxDuration = 60`**, and the invariant is
`maxDuration > pre-transaction work + maxWait + timeout`. `commitImport`'s
interactive transaction is configured `maxWait: 5_000` (pool acquire) +
`timeout: 40_000`, consumed sequentially — 45s — leaving ~15s for the work that
happens in the same invocation *before* the transaction opens (`req.formData()`
buffering the upload, `getImportActor()`, `file.text()`, and the two parallel
load queries inside `commitImport`) plus unwind. A shorter budget would let the
platform kill the function mid-transaction — or before it even reaches one —
instead of letting it abort cleanly into the route's catch block. **60 is
deliberate, not a "safe" round number:** Vercel rejects an unsupported
`maxDuration` at *deploy* time, which `next build` in CI cannot catch, so the
first place an unverified higher value fails is the production deployment.
Raise it only once a measured production run needs more *and* the plan's real
ceiling is confirmed.

**Errors don't leak internals** — generic `"Import failed"` / a specific but
non-sensitive parse error, plus a server log.

---

## 9. Data retention & minimization

**Closed receipts are purged after 90 days.** The expiry is stamped exactly 90
days after close; the worker hard-deletes on expiry. `purgeExpiredTransfers`

**Deactivated accounts are hard-deleted after 3 months** (with skip conditions).
`purgeDeactivatedUsers`

**Closed tickets are immutable** — once "Closed", a ticket cannot be reopened,
edited, or modified.

**Changes are audit-trailed** across `ItemEdit` (field-level history: holder,
`deviceUIC`, `deviceCategory`, …), `ItemAudit`, and `ReturnTransaction` — each
written in the same transaction as the change it describes.

---

## 10. Database posture

> **RLS is *not* the authorization boundary.** The app reaches Postgres only
> through Prisma on a privileged role that **bypasses RLS**. All authz lives in
> the app layer ([§2](#2-authorization)). Never assume the DB scopes rows for you.

- Every table is **RLS enabled with no policy** = deny-all for the `anon` /
  `authenticated` PostgREST roles.
- The **`rls_auto_enable` event trigger** makes new tables inherit RLS-enabled
  automatically. See `prisma/migrations/20260721170000_public_access_setting/migration.sql`.
- The **Supabase Data API and anon key stay unused** — no Supabase JS client, no
  anon key in the app.
- **Never disable RLS** on a table (that exposes it to the public anon key) and
  **never add a permissive policy** without explicit review.
- **Never `GRANT EXECUTE`** on a `public` function to `anon` / `authenticated`.
- Runtime uses the **transaction pooler** (6543); migrations use the
  **session/direct** connection (5432).

---

## 11. Supply chain & CI/CD

**Semgrep SAST runs on every push and PR to `main`** with the rulesets
`p/security-audit`, `p/secrets`, `p/javascript`, `p/typescript`, `p/react`, and
`p/owasp-top-ten`. `.github/workflows/ci.yml`

> It runs from the official `semgrep/semgrep` **docker image** — a pipx install
> crashes on the runner's Python 3.12 (`ModuleNotFoundError: pkg_resources`).
> Don't "simplify" it back to pipx.

**ERROR-severity findings block the build.** Full findings upload as SARIF to the
GitHub Security tab, so lower-severity or accepted-by-design noise doesn't
permanently redden the pipeline.

**`next build` is a second required gate** — type and compile errors block a merge.

**The workflow token is least-privilege** — `contents: read` plus
`security-events: write`. SARIF upload is skipped for forked PRs, whose read-only
token can't write `security-events`.

**No `${{ }}` interpolation of `github` context data into `run:` steps.** Branch
names and other `github` context values are attacker-controlled on a fork PR, so
interpolating them into a shell command is script injection. Pass them through an
intermediate `env:` var and quote the expansion. Semgrep enforces this
(`run-shell-injection`) — it caught exactly this bug in the `Security docs
current` job before it merged.

**`main` is branch-protected** — all three checks required (`Semgrep SAST`,
`Build (next build)`, `Security docs current`), `strict` mode (the branch must be
up to date). Admin bypass exists for emergencies only.

**There is no pre-push review gate — it was removed on 2026-07-30.** An `xhigh`
review marker used to be required per-commit, enforced by a Claude Code
`PreToolUse` hook (`.claude/hooks/xhigh-review-gate.sh` + its
`.claude/settings.json` entry). Both are gone, so **nothing blocks a push**.
Running `/code-review xhigh` on a branch before opening a PR is still expected,
but it is a convention now, not enforcement. Two things worth knowing: a stale
`.git/xhigh-review-ok` file may still sit in a local clone (it is **inert** and
means nothing), and `.claude/settings.json` is untracked local config, so
removing the hook in one clone does not remove it from anyone else's — check
your own if a push is unexpectedly blocked. The only enforced gates are the
three required CI checks above, and they run on the PR, not on the push.

**This document is itself CI-enforced.** The `Security docs current` job runs
`scripts/check-security-docs.mjs` on every PR and fails it when a watched
security file changes without this file changing. See
[Keeping this current](#keeping-this-current).

**Dependencies are vetted before install** — `npm view <package>` first, to catch
hallucinated or unhealthy packages.

**Migrate before push** — `next build` never runs `migrate deploy`, so a prod
migration must be applied *before* the merge deploys. See [`../DEPLOY.md`](../DEPLOY.md).

---

## 12. Rate limiting

**Five policies.** `src/lib/rate-limit.ts`

| Policy | Budget | Keyed on | Applies to |
|---|---|---|---|
| `AUTH_POLICY` | **5 per 15 min** | scope + IP + **submitted email** | sign-in, password-reset request |
| `AUTH_POLICY` | **5 per 15 min** | scope + IP + **reset-token hash** | reset submission |
| `UNLOCK_POLICY` | **20 per 15 min** | scope + IP | PIN unlock — one org-wide secret, so no identity exists and successes count |
| `AUTH_SPRAY_POLICY` | **60 per 15 min** | scope + IP | the ceiling over the identity-keyed surfaces; separately, scope `api-auth-write` meters other `POST /api/auth/*` |
| `API_POLICY` | **300 per min** | scope + IP | two buckets: `GET /api/auth/*`, and `/api/*` + the public PII surface (`/`, `/i/*`, `/receipts/*`) **for anonymous callers only** |
| `AUTH_VELOCITY_POLICY` | **100 per 5 min** | one global key ×2 | the botnet detector — one bucket alerts on every surface, one escalates on sign-in only |

**Auth buckets are composite: `(scope, network, account)`, under a per-network
ceiling.** Neither half works alone. A purely per-IP limit punishes the wrong
people — the service desk shares one NAT egress IP, so one person mistyping
their password five times would lock out every colleague. A purely composite key
is not a limit at all — the email is supplied by whoever is submitting the form,
so rotating it mints a fresh 5-attempt bucket and one host could spray thousands
of accounts. Together: five failures per account per network, under sixty
attempts per network. The email is **hashed** (`rateLimitIdentity`, SHA-256
truncated to 64 bits) before it becomes a key — "who tried to sign in as whom"
must not sit in a third-party Redis or a log line — and normalised first, so
capitalisation is not a fresh budget.

**A lockout is not a flat fifteen minutes — read the window as decaying.**
Upstash's sliding window is a weighted COUNTER, not a log: it discounts the
previous window by how far you are into the current one, so five failures, one
minute into a fresh block, score `5 × (1 − 1/15) = 4.67` and are let through.
Its reported `reset` is the edge of the fixed wall-clock block, so running out
near a boundary correctly reports "try again in less than a minute". The real
range is **about a minute to the full window**, depending where in the block the
budget ran out — observed in production, not theorised.

> The in-memory fallback differs here: it is an exact timestamp log, so it holds
> for the full window every time. The two backends agree on *what* counts (a
> refused attempt is never recorded) but not on how long a lockout lasts.
>
> The cost is roughly one extra attempt per `window / limit` — about one every
> three minutes on the auth bucket. That is the ordinary sliding-counter
> tradeoff and the reason this is written down rather than "fixed": the
> alternative, an exact log in Redis, stores a timestamp per attempt and turns a
> flood into unbounded memory.

**The store is Upstash Redis, with a per-instance fallback.** `@vercel/kv` is
deprecated by Vercel; the Marketplace Redis integration injects
`KV_REST_API_URL` / `KV_REST_API_TOKEN`, which is what this reads (also
`UPSTASH_REDIS_REST_*`). With neither pair set it falls back to in-process
counters and logs a warning — a real sliding window, but one that only sees
requests landing on the same warm instance, so **it is not the production
posture**. `rateLimitStoreConfigured()` reports which is live. Both backends
agree that a *refused* attempt is not recorded (Upstash's Lua script returns
before its `INCRBY`), so the fallback and Redis mean the same thing by "5 in 15
minutes" — and an in-memory bucket can never hold more than `limit` entries.

**Enforced in two places, on purpose.** `src/proxy.ts` covers `/api/auth/*` and
the anti-scraping limit; the interactive flows — `loginAction`,
`requestPasswordResetAction`, `resetPasswordAction` (`src/app/actions/auth.ts`)
and `unlockAction` (`src/app/actions/unlock.ts`) — limit themselves, because a
429 to a Server Action POST is not a message a user can read: `useActionState`
cannot render it and the page breaks with an error-boundary digest.

**`/api/auth/*` is metered OUTSIDE the `auth()` wrapper.** The Auth.js endpoint
must never reach the login gate (signing in would redirect to itself), and the
`auth()` wrapper resolves the session *before* it calls its handler — so
delegating would make every request to the auth endpoint pay a second session
read, i.e. a database query, on the one path an unauthenticated attacker can
hammer. `isApiAuthPath` matches on a path **segment**, so a future `/api/authors`
is not silently exempted from the login gate.

**`POST /api/auth/callback/*` is CLOSED (404), not throttled.** It is a fully
working second front door to the credential check, and one this app never uses —
`loginAction` calls `signIn()` in process. Left open it walked around *all three*
protections layered onto the Server Action: the Turnstile challenge, the
per-account composite bucket (the proxy cannot key on an email that lives in the
POST body it must not consume), and the botnet counter, which only `loginAction`
feeds. `GET` of a callback path is still allowed, for any OAuth-style provider
added later.

**Nothing else may borrow the `login` scope.** Other `/api/auth/*` writes are
metered under `api-auth-write`. Sharing it was a whole-desk lockout waiting to
happen: `POST /api/auth/signout` needs no CSRF token, no body and no session, so
60 of them from anywhere would fill the very bucket that gates sign-in and refuse
every technician behind that egress for fifteen minutes — the failure the
narrow-bucket-first ordering exists to prevent, reached through a second door.
The reason the scopes were shared is gone: the credentials callback is closed.

**A login POST carrying `X-Auth-Return-Redirect` is refused outright.**
`signIn()` copies the incoming request headers into the request it hands to
`@auth/core` (`new Headers(await nextHeaders())`), and that library treats the
header as *"return the error instead of throwing it"*. A crafted login POST
carrying it therefore turned a **wrong password into a `NEXT_REDIRECT`** —
indistinguishable from success — so the action refunded the token and told the
detector nothing: unlimited per-account guessing, silently. It is charged as a
failed attempt rather than ignored, so probing costs what guessing costs.

> The header guard is belt and braces, not the fix. `loginAction` no longer
> infers success from a thrown redirect at all: it calls `signIn(…, { redirect:
> false })`, treats a returned `?error=` URL as a failed attempt, and issues the
> `redirect()` itself. Blacklisting one header would have closed today's
> instance while any future change that turns an `AuthError` into a redirect
> silently re-opened it — and this is a beta dependency.

**The auth budget is spent up front and REFUNDED on success.** Checking the
bucket first and charging only failures reads better but is a
time-of-check/time-of-use hole exactly as wide as the bcrypt compare: 500
concurrent sign-in POSTs would all read an untouched bucket and all be admitted,
turning "5 per 15 minutes" into "5 × the attacker's parallelism". So the token is
taken before the password check, and `resetRateLimit` gives back **the
per-account bucket only** when the attempt succeeds. An unexpected server error
does **not** refund: a crash is not evidence the credentials were right.
- **The shared per-network ceiling is never refunded.** Emptying it on success
  would let anyone holding one valid credential clear everybody's counter
  between guesses — five tries each against an unlimited number of accounts,
  i.e. the ceiling doing nothing. That is why it is 60 rather than something
  tighter: it counts attempts that reached a password, successes included.
- **Order matters: narrow bucket first, ceiling second.** Charging the shared
  ceiling first meant 60 cheap requests naming one address — 55 of them refused
  by the per-account bucket and still charged — locked every colleague behind
  that egress out of sign-in for fifteen minutes, which is exactly the failure
  the composite key exists to prevent.
- **A ceiling refusal does not refund the narrow token either.**
  `resetRateLimit` EMPTIES a bucket rather than decrementing it, so "handing it
  back" let an attacker who saturates the ceiling with throwaway addresses wipe
  a real account's failure count on every subsequent attempt — lifting the
  effective per-account guess rate from 5 to 60 — and put an O(keyspace) Redis
  `SCAN` on a path an unauthenticated caller controls. Over-charging one token
  during an attack is the safe direction.
- **Only an identity-keyed bucket may ever be refunded.** The PIN-unlock bucket
  is `(scope, ip)` — shared by everyone on that network — so refunding it on a
  correct PIN handed an attacker on the same egress a fresh five guesses every
  time a colleague unlocked legitimately. It is no longer refunded; a successful
  unlock costs one of the five, which the budget absorbs. The reset-submit
  bucket gained a **token hash** instead, which makes it the caller's own and
  stops five people with expired links locking out a sixth holding a valid one.
  That bucket is nonetheless **not** refunded on success, and deliberately so:
  a successful reset *consumes* the token the bucket is keyed on, so the freed
  attempts could never be spent by anyone — refunding would buy nothing but the
  O(keyspace) `SCAN` below. The login refund is the one that is genuinely
  reusable, because the email persists.
- *Accepted cost:* the refund is `resetUsedTokens`, which on Upstash `SCAN`s for
  the identifier's keys — O(keyspace), not O(1). It runs only on SUCCESS, tens
  of times a day, never on the failure path an attacker controls. Do not move it
  onto a hot path.
- The reset-*request* action never refunds: the abuse there is volume itself,
  and its refusal is IP-shaped rather than account-shaped, so it still leaks
  nothing about whether an address is registered.

**Reads of `/api/auth/*` do not spend the sign-in budget** (`GET`/`HEAD`) —
discovering CSRF/session state must not exhaust it — but they are metered under
`API_POLICY` (their own `api-auth` bucket), which is the only limit they have.

**Signed-in staff are exempt from the anti-scraping limit.** `/items` links to
`/i/<id>` for every row on the page and Next prefetches those links in
production — the proxy runs on prefetches too — so one technician scrolling
inventory would spend ~50 tokens, and the whole desk shares one egress IP. The
limit exists for anonymous scraping of the public surface and is applied there.
Knowing the caller is signed in needs the session read, but that costs little
for the traffic being shed: an anonymous request carries no session cookie, so
Auth.js short-circuits before any JWT decode or database query.

**The `/api/*` arm of that anonymous limit currently guards nothing, and that is
worth knowing rather than trusting.** Gate 0b meters anonymous callers on the
public surface **or** any `/api/*` path — but the app has exactly three API
routes today, and none of them reach it: `/api/auth/*` returns from gate 0a
before the wrapper runs, and `/api/cron/*` and `/api/items/import` are excluded
from the matcher entirely (each authenticates with its own constant-time bearer
compare; see [§8](#8-background-jobs-cron) and
[Known gaps #8a](#known-gaps--accepted-risks)). The clause is correct code kept
for the next route added under `/api/`, which will inherit the limit by default
— it is not a control anything may lean on today.

**`/api/cron/*` is deliberately excluded** from the proxy matcher. It
authenticates with a constant-time `CRON_SECRET` compare and is called once a
day; a shared per-IP bucket would let unrelated traffic from the same egress
starve the purge job. See [§8](#8-background-jobs-cron).

**Global velocity tracking catches what per-IP buckets cannot.**
`src/lib/auth-velocity.ts` counts failed credential checks app-wide on one
shared Redis key. Ten thousand hosts making four attempts each never trip a
5-per-IP limit, but the aggregate is unmistakable. Crossing 100 failures in 5
minutes puts the app in an **elevated** state, which:
- logs one structured `auth.velocity.elevated` line per minute for a log drain
  to alert on (rate-limited, or the alarm becomes the flood), and
- makes Turnstile **strict** — see [§13](#13-captcha--cloudflare-turnstile).

It deliberately does **not** block. A global refusal is a global outage any
attacker could trigger on purpose, which would make the detector the
vulnerability. Only *genuinely failed credential checks* are counted — not
throttled requests, malformed submissions or challenge refusals, which never
reached a password; counting those would let one host raise the app-wide alarm
without guessing anything. The state clears on its own as the window slides.

**Two buckets, because the detector has two jobs and only one of them may be
attacker-triggerable.**
- **Alerting** counts every guessable surface — sign-in, a wrong PIN at
  `/unlock`, a bad reset token. Broad is right: a blind spot costs the whole
  feature, a false alarm costs a log line.
- **Escalation** (strict Turnstile) counts *sign-in failures only*. `/unlock`
  needs no account and carries no challenge of its own, so letting it raise the
  escalation would hand an unauthenticated attacker a cheap global switch: fill
  the bucket, and every sign-in whose Turnstile verification is `unreachable` is
  refused app-wide. That is exactly the failure this section opens with — a
  state an attacker can trigger turns the detector into the vulnerability.

**The escalation LATCHES for a full window.** Refused hits are deliberately not
recorded, so at exactly the threshold the moment the oldest entry ages out the
bucket reports room again; an unlatched check would flicker off request by
request mid-attack and wave through roughly half the unverifiable submissions it
exists to refuse.

**The public surface is `/`, `/i/*` and a receipt or its PDF — not the whole
`/receipts/` prefix.** The bare prefix also caught `/receipts/new` (the staff
hand-receipt builder) and `/receipts/<n>/return` (admin-only), so an anonymous
request to either met the browser check and the PIN gate instead of the sign-in
redirect. Authorization was never affected — `requireUser` runs in-page
regardless — but a colleague following a bookmarked builder link got a
plain-text 403 rather than being sent to log in.

**The proxy matcher's exclusions are SEGMENT-anchored** with `(?:/|$)`.
Unanchored they were prefixes, so a future `/api/cronjobs`, `/logins`,
`/unlockables` or `/terms-of-service` would have skipped the proxy entirely — no
login gate, no PIN gate, no rate limit, no session-cookie refresh. That is the
same hazard `isApiAuthPath` guards against in code; the fix had been applied
there and not to the regex one screen below.

**Anonymous requests that do not present as a browser are refused (403).**
`looksAutomated` in `src/proxy.ts`: a missing or blank `User-Agent` is the strong
signal (every real browser sends one), plus a short list of default automation
agents (`curl/`, `python-requests`, `Scrapy`, …). `RATE_LIMIT_DISABLED=true`
turns it off along with the limiter, so a dev server can be driven with `curl`.
**`HeadlessChrome` is
deliberately not on that list** — headless browsers are what Turnstile is for,
a UA match buys nothing against one (a single line of Playwright changes the
string), and blocking it refuses real tooling: it broke this repo's own e2e
suite, and would break uptime monitors the same way. Checked *before* a
rate-limit token is spent, so a header-less flood cannot exhaust the budget of
everyone sharing its IP. Scoped to anonymous callers on the public surface and
NOT applied to `/api/auth/*` — a signed-in technician may be driving a script,
and Auth.js callbacks must not depend on a UA string. **Trivially spoofable by
one line of code**; it is defence in depth against the lazy majority, listed
under [Known gaps](#known-gaps--accepted-risks) rather than counted as a control.

**It fails OPEN.** A Redis outage logs and allows the request rather than
locking every technician out of the property book. Deliberate availability
choice for an internal tool whose real authz boundary is per-route; recorded
under [Known gaps](#known-gaps--accepted-risks).

**`RATE_LIMIT_DISABLED=true`** short-circuits the limiter entirely. It exists for
local work; never set it in a deployed environment.

---

## 13. CAPTCHA — Cloudflare Turnstile

**Where.** The three unauthenticated forms that do work for an anonymous caller:
`/login`, `/forgot-password` and `/reset-password`.
`src/components/TurnstileWidget.tsx` renders the widget; `loginAction`,
`requestPasswordResetAction` and `resetPasswordAction` verify the token
server-side against `challenges.cloudflare.com/turnstile/v0/siteverify`.
`src/lib/turnstile.ts`

> `/reset-password` got the challenge last, and is the one surface where a
> correct guess is an outright **account takeover** rather than a step towards
> one. It was also escalating to a mitigation (strict Turnstile) that it did not
> itself render.

**Config-gated, off until both keys are set.** `NEXT_PUBLIC_TURNSTILE_SITE_KEY`
(public by design — the client needs it) and `TURNSTILE_SECRET_KEY`. **Both** are
required: a site key alone renders a widget nobody checks, and a secret alone
refuses every sign-in, because no form could produce a token. With either
missing the widget is not rendered and verification is skipped, so dev, CI and a
deploy that has not been given keys keep working. `turnstileConfigured()` reports
which.

**Verified server-side, never trusted from the client.** The widget injects a
hidden `cf-turnstile-response` field into the enclosing form, which reaches the
Server Action through FormData. A client that omits the widget gains nothing —
the action verifies regardless, and a missing token is a refusal.

**Checked after the rate limiter, before the password.** A throttled request must
cost as little as possible; a challenge exists to keep headless scripts away from
bcrypt entirely. A refused challenge is **not** counted by the velocity detector
([§12](#12-rate-limiting)) — it never reached a credential check.

**Failure posture, and the one place it flips.** A token Cloudflare *refuses*
blocks the submission — that is the feature. A failure to *reach* Cloudflare
(timeout, 5xx, non-JSON) does not: it is logged and the submission proceeds,
because a third-party outage must not lock the service desk out of its own
property book, and the password check plus the rate limiter still apply. The
same goes for `invalid-input-secret` / `missing-input-secret`, which mean *we*
are misconfigured, not that the visitor failed — blocking every sign-in on our
own typo would be a self-inflicted outage. `internal-error` — Cloudflare
telling us to retry — takes the same path.
**While the global failure velocity is elevated, that trade flips:** an
unverifiable submission is refused. During a distributed attack an unverifiable
sign-in is not worth the benefit of the doubt; a real technician retries in a
minute.

**Rendered explicitly, not by the script's class scan.** Implicit rendering races
React hydration and can leave a form that submits with no token, which the server
then refuses — a broken sign-in with no visible cause. The widget is also reset
after a rejected submission, because a token is single-use. A `<script>` tag that
fails to load is **removed**, not reused: a tag that has already fired its
terminal `error` never fires another event, so re-attaching to it would hang the
retry forever and leave the form permanently unsubmittable in that tab.

**The token is length-capped before the round trip** (2 KB). Without it the
submitter chooses how many bytes we upload to Cloudflare, and a few hundred KB
reliably earns a 413 or blows the 5-second timeout — both of which land in the
allow-on-unreachable branch. That would turn fail-open from an outage
accommodation into a bypass anyone could trigger on demand.

**The pages gate on `turnstileWidgetSiteKey()`, not `turnstileSiteKey()`** — the
former is null unless BOTH keys are present. Rendering on the site key alone is
the security theatre this section's config gate exists to prevent: a live widget
that challenges visitors and is then never verified.

**The widget is `interaction-only`** — invisible unless Cloudflare decides the
visitor must interact.

**The button is only held AFTER hydration.** The server HTML ships it enabled;
`useSyncExternalStore` flips it once the client mounts. Deriving the disabled
state from the challenge alone put `<button disabled>` in the initial HTML, so
any failure that stopped the bundle running — a content filter, a parse error —
left an inert form with no message and no way to sign in, because the release
deadline lives in that same JS. It also defeated React's progressive
enhancement. `LoginForm.test.tsx` asserts the SSR output through
`renderToString`, since a hydrating render hides it.

**The submit button is held until a token exists** ("Checking your browser…").
Filling in an email and password takes a second or two; submitting first sends a
tokenless form, which the server correctly refuses with "could not verify that
request came from a browser" — for a completely valid login. Verified against a
real browser and real keys: it happens on a fast submit. The button is
*released* if the challenge errors outright (blocked CDN, offline), because a
button that can never be pressed, with nothing explaining why, is worse than a
refusal that says something.

**The hold has a 15-second deadline, re-armed on EVERY return to `pending`.**
Turnstile can render, fire no error, and simply never call back — that is what
it does to a browser it distrusts, and it is observable (it is how Playwright
behaves against real keys). Some real visitors land there too: a stale WebView,
a hardened privacy browser, a CDN hiccup. Armed only at mount, the deadline was
already spent by the time it was needed: the commonest way to reach `pending`
again is a **single mistyped password**, and the form could then hang forever
with nothing to click. A token expiring on an idle tab is the same path.

**Turnstile refuses automated browsers, including our own test suite.** With
real keys, Playwright's Chromium renders the widget, fires no error — so the
site key and hostname are accepted — and simply never receives a token. That is
the product working. It does mean `tests/e2e` cannot sign in against real keys,
so `playwright.config.ts` pins Cloudflare's always-pass **test** keys for the
server it starts (`1x0000…`). Don't "fix" a hanging e2e sign-in by weakening the
challenge.

---

## Known gaps & accepted risks

Tracked deliberately, so nobody re-discovers them as new findings.

**0c. A Vercel API token and a deploy hook sit on a technician workstation, and
together they can deploy production unattended.** ⚠️ *Accepted; two exits exist.*
`scripts/gmail-token-rotation/` ([§6](#6-secrets--data-leakage)) needs a Vercel
token to write `GMAIL_REFRESH_TOKEN` and a deploy hook to make it take effect.
The token is **project-scoped**, so the blast radius is this one project rather
than the whole account, and both it and the hook URL are DPAPI-encrypted and
bound to one Windows user on one machine. What remains is that anyone with that
user's live session can trigger a production deploy, and that a successful
rotation ships `main` with nobody watching — which collides with the
migrate-before-push rule (`DEPLOY.md`).
The token also expires (Vercel offers no non-expiring option), so there is a
second, annual renewal. It fails safe: an expired token surfaces as a 403 and a
failed rotation, never as silently mis-sent mail.
The root cause is that the Google OAuth consent screen is deliberately left in
**Testing** status, which caps refresh tokens at 7 days. Both exits remove the
tooling entirely rather than mitigating it: publish the consent screen (free,
immediate), or move the sender to Google Workspace on `dcsim.us`, where a service
account with domain-wide delegation needs no refresh token at all. Until one is
taken, this risk is the price of the workaround. Revisit whenever the `.mil`
deliverability work moves.

**0a. A visitor whose network blocks Cloudflare cannot sign in at all** once
Turnstile is configured. ⚠️ *Accepted, with an operational lever.*
The server leg fails OPEN (an unreachable Cloudflare lets the submission
through); the CLIENT leg cannot. A browser behind a proxy or content filter that
blocks `challenges.cloudflare.com` produces no token, and a tokenless submission
is refused on every retry. The widget releases the submit button so they get a
message rather than a dead control, and the message names the likely cause — but
it is the end of the road for them. It cannot be made symmetrical from the
server: there is no way to distinguish "the client could not reach Cloudflare"
from "the client chose not to send a token", and trusting the client on that is
the whole bypass. The lever is unsetting `TURNSTILE_SECRET_KEY`, which disables
the check everywhere.

**0. The bot defences are config-gated and spoofable, in that order.**
*Resolved for production 2026-07-29; still true of any environment without keys.*
Both `NEXT_PUBLIC_TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` **are set in
production** — verified by hand, real keys, real browser, sign-in works — so the
CAPTCHA runs and the botnet detector's escalation is a real mitigation rather
than a log line. The gate remains config-shaped, which is the residual risk:
anywhere those two vars are unset (dev, CI, a fresh preview, or prod after a
mistaken deletion) no CAPTCHA runs at all ([§13](#13-captcha--cloudflare-turnstile)),
and because Turnstile is what the botnet detector escalates to, the detector
silently degrades to **alerting only**. Nothing warns about that state except
`turnstileConfigured()`. Note also that unsetting `TURNSTILE_SECRET_KEY` is the
documented recovery lever (Known gap 0a) and needs a redeploy to fully take
effect, since `NEXT_PUBLIC_*` is inlined at build time.
Separately, the User-Agent filter ([§12](#12-rate-limiting)) is
defeated by one line in a scraper; it is deliberately a coarse filter for the
lazy majority, not a control, and it must never be the thing something else
relies on.

**1. Rate limiting is only as good as the store behind it, and it fails open.**
*Store provisioned 2026-07-29; the fail-open and IP-identifier properties remain
accepted.*
The Upstash Marketplace Redis integration **is** attached to the Vercel project
(`KV_REST_API_URL` / `KV_REST_API_TOKEN`), so production runs the shared sliding
window rather than the per-instance in-memory fallback — confirmed behaviourally,
not just by config: a production lockout decayed at a window boundary, which only
the Upstash weighted counter does ([§12](#12-rate-limiting)); the in-memory log
would have held the full 15 minutes. If those vars are ever lost the app does not
fail — it silently drops back to the **per-instance fallback**, which throttles
only requests landing on the same warm lambda; `rateLimitStoreConfigured()` is
what reports which is live. Two further accepted properties, both deliberate: a Redis
outage **allows** traffic rather than locking the desk out, and the identifier
is the client IP taken from `x-vercel-forwarded-for` → `x-forwarded-for` →
`x-real-ip` — forgeable if this app is ever served without a proxy that
overwrites those headers, and shared by everyone behind one NAT egress.
`x-real-ip` is DELIBERATELY last: a reverse proxy configured with only
`proxy_set_header X-Forwarded-For` leaves it client-settable, and preferring it
there would let one `curl -H` mint a fresh bucket per request and walk through
every limit in the module.

**2. Public receipts and item pages are enumerable and unauthenticated.**
*Accepted product requirement*, not a bug — behind the shared PIN when the flag
is on. See [§3](#3-public-surface--the-pin-gate).

**3. The reset token appears in server access logs** on the initial GET.
*Mitigated* by `no-referrer` and address-bar scrubbing; the full fix is deferred.
See [§4](#4-password-reset).

**4. The public gate is one shared org-wide PIN,** not per-person, and rotating
it is non-retroactive — existing unlock cookies stay valid until they lapse
(≤12 hours).

**5. JWT freshness costs one DB read per authenticated request.** *Accepted* to
keep revocation working without a session table.

**6. There is no user-level non-repudiation — only server-attested attribution.**
⚠️ *Owed to a human, if the requirement is ever real.*
The receipt seal signs the acting technician's id ([§7](#7-cryptographic-receipt-seal)),
but the only private key is the server's `SIGNING_PRIVATE_KEY`. A valid seal is
therefore forgeable along **two** paths without the named person doing anything:
compromise of their credentials/JWT (the id is taken from the session), or
possession of the signing key — which means anyone with Vercel env access, a
compromised deploy, or the database plus that key can write a row and seal it
under any `sealedByUserId`. The second path is the load-bearing one: it is held
by whoever administers the deploy, so in a genuine dispute ("I never issued that
laptop") the technician's defence is not "someone stole my password" but "an
admin could have created that record", and no verification we can run rules it
out. Closing it requires a keypair whose private half never reaches the server —
WebAuthn/passkey in the device secure element, or PIV/CAC (scratched as
un-hostable on Vercel, see the CAC decision). Until then, **do not claim
non-repudiation** in UI copy, docs, or briefings; claim tamper-evidence and
attribution.

**7. Most privileged mutations record no actor, and there is no authentication
event log.** ⚠️ *Owed to a human.*
Receipts (`Transfer.createdByUserId`/`sealedByUserId`), returns
(`ReturnTransaction.processedBy*`), item field edits (`ItemEdit.editedBy*`) and
possession audits (`ItemAudit.auditedBy*`) all record who acted and survive that
account's deletion. Nothing else does: `markItemsReadyAction` and
`toggleItemStatusAction` (`src/app/admin/actions/items.ts`), all three
service-queue actions (`.../queue.ts`), receipt timers (`.../receipt-timer.ts`)
and the user management actions (`.../users.ts`) each `await requireAdmin()` and
then discard the identity — so *who retired this device*, *who closed that
ticket*, and *who promoted this account to ADMIN* are unanswerable. Separately
there is no log of logins, failed attempts, lockouts, resets, or PIN unlocks, and
no IP/user-agent capture anywhere, so account-compromise claims cannot be
corroborated. Note also that only receipts are sealed: `ItemEdit`, `ItemAudit`
and `ReturnTransaction` are ordinary mutable rows with no hash chain, and the app
connects on a privileged role that bypasses RLS ([§10](#10-database-posture)), so
DB-level history rewriting leaves no trace.

**8. Anyone holding `MDM_IMPORT_SECRET` can create and update inventory rows.**
*Accepted, bounded.* [§8](#8-background-jobs-cron). `POST /api/items/import`
has no per-caller identity beyond the one shared secret — unlike a signed-in
admin's session, there is no way to tell one holder of the secret from
another, and no way to revoke one holder without rotating the secret for
everyone (including the legitimate scheduled job, which then also needs
updating). The blast radius is bounded three ways: `MAX_IMPORT_ROWS` (2000)
caps a single call, the endpoint can only create/update items and their
history — it has no delete, user-management, or receipt capability — and
every row it touches is attributed in `ItemEdit`/`ImportBatch` to the fixed
`mdm-import@service.invalid` account, so a bad import is visible and
reversible (re-import a correct CSV) even though it can't be individually
attributed to whoever actually held the secret at the time.

**8a. `POST /api/items/import` is unmetered and unlogged — anonymous
secret-guessing against it costs nothing to attempt and leaves no trace.**
*Accepted.* Excluding the route from `src/proxy.ts`'s matcher (needed so the
route's own session-less request isn't redirected to `/login` before the
handler can read the `Authorization` header, [§8](#8-background-jobs-cron))
also removes it from the proxy's 300/min anonymous rate limit
([§12](#12-rate-limiting)) and the automation User-Agent filter, same as
`api/cron`. There is no per-attempt log of a rejected guess either — only
`console.error` on an unexpected failure, not on a routine 401. In practice
this is not exploitable: `hasValidBearerSecret` compares against a long
random value with `timingSafeEqual` ([§8](#8-background-jobs-cron)), so
brute-forcing it is computationally infeasible regardless of request rate,
and the constant-time compare means a flood buys an attacker no timing
signal either. Accepted rather than re-metering the route, because putting it
back behind the proxy's IP bucket is what caused the original bug this
endpoint exists to fix — the shared secret is the only control this endpoint
needs, and it does not weaken under volume.

**9. A dead Gmail refresh token stops outbound mail entirely, with no
fallback.** *Accepted, by design — see [§6](#6-secrets--data-leakage).*
`getEmailSender()` selects `GmailOAuthSender` by environment presence only and
never falls back to Resend or the log stub when a send fails, so a rejected
`invalid_grant` refresh (an expired, revoked, or rotated-out-from-under-it
token) surfaces as a thrown error on every outbound email until someone
re-mints `GMAIL_REFRESH_TOKEN`. This is deliberate: silently rerouting mail
through a different transport, or swallowing the failure, would hide a real
outage behind a "sent" that never went anywhere.
The token expires roughly weekly because the Google OAuth consent screen for
this app is **deliberately kept in Testing publishing status** rather than
published — an owner decision, recorded in full at
[Known gaps 0c](#known-gaps--accepted-risks), not a misconfiguration to "fix"
by itself. The accepted mitigation is the workstation rotation tooling
documented there (`scripts/gmail-token-rotation/`), which *reminds* on a
6-hourly schedule — escalating from a normal toast at 3 days to critical past
7 — but the rotation itself is initiated by a person. Until the consent screen
is published or the sender moves to Google Workspace (0c's two exits), expect
this failure mode on a roughly weekly cadence absent that person acting on the
reminder.

**10. Everyone copied on a custody email can see the other addresses on it.**
*Accepted, and a deliberate change of behaviour on 2026-08-04.* A receipt,
return or pickup notice is now **one message to the customer with a CC list**
([§6](#6-secrets--data-leakage)) rather than a separate message per party. CC is
not BCC, so each recipient learns every other address on the receipt — including
the `army.mil` records mailbox and, where a receipt is between two outside
parties, the other party's address. This is intended (the parties are named on
the document the message carries), but it is a disclosure the previous
one-message-per-recipient behaviour did not make. Two knock-ons: the CC list
ships as **defaults in code** rather than required configuration, so editing
`DEFAULT_RECEIPT_CC_EMAILS` changes who receives receipt PII with no config
change and no deploy-time signal — which is why `src/lib/email-recipients.ts` is
on the watch list — and one message means one delivery outcome, so a single hard
rejection can now cost every recipient the notice. Switching the copies off is
`RECEIPT_CC_EMAILS=""` (deliberately distinct from unset, which means "use the
defaults"); moving them to BCC would be a behaviour change requiring a decision,
since the reply-all thread is the point of the change.

---

## Keeping this current

Edit this file **in the same commit as the code**, the same rule the project
applies to `CLAUDE.md` and `CHANGELOG.md`.

### This is enforced

The **`Security docs current`** CI job fails any PR that changes a watched
security file without changing this document.

```bash
npm run check:security-docs        # run it locally, against origin/main
node scripts/check-security-docs.mjs <baseRef>
```

Exit codes: `0` pass or bypassed · `1` policy violation · `2` config problem
(e.g. the base ref isn't fetched — never silently treated as a pass).

**The watch list is at the top of `scripts/check-security-docs.mjs`** (exported as
`WATCHED`, and asserted by `scripts/check-security-docs.test.mjs`). It currently
covers, by area:

- **authn / session** — `auth.ts`, `lib/authz.ts`, `lib/session-freshness.ts`,
  `modules/users/users.service.ts`, `lib/password.ts`, `app/actions/auth.ts`
- **password reset** — `lib/password-reset.ts`, `lib/reset-token.ts`
- **the public PIN gate** — `src/proxy.ts`, `lib/public-access*.ts` (including
  `-cookie` and `-guard`), `app/actions/search.ts`, `app/actions/unlock.ts`,
  `app/admin/actions/public-access.ts`
- **anti-abuse** — `lib/rate-limit.ts`, `lib/auth-velocity.ts`,
  `lib/turnstile.ts`, `components/TurnstileWidget.tsx`, and the four pages/forms
  that decide whether the challenge is rendered and whether a tokenless form can
  be submitted
- **allowlists** — `modules/items/sort-keys.ts` (the ORDER BY identifiers),
  `app/admin/actions/readiness.ts` (the hand-settable readiness targets)
- **session-less writes** — `app/api/cron/**`, `lib/cron-auth.ts`,
  `app/api/items/import/route.ts`, `modules/items/import-actor.ts`
- **outbound mail** — `lib/email.ts`, `lib/email-recipients.ts`,
  `lib/gmail-oauth-email.ts`
- **infrastructure** — `next.config.ts`, `.github/workflows/ci.yml`,
  `scripts/gmail-token-rotation/` (directory-wide)

**A new security-relevant file must be added there**, or it escapes the guardrail
silently — that list is the one part of this system that can rot without
anything complaining.

**Bypass:** put `[skip security-doc]` in a commit message when a change genuinely
doesn't alter the posture (a rename, a comment, a mechanical refactor). The check
then passes but prints what it waived, so the bypass is visible in review rather
than silent.

### What triggers an update

Update this file whenever a change:

- adds, removes, or alters an **authn/authz check** — a new Server Action, a
  changed role gate, a new field a `USER` may edit;
- touches **crypto, tokens, cookies, or secrets** — a new env var, a new signing
  or hashing path, a changed TTL or cost factor;
- changes the **public surface** — a new unauthenticated route, a widened gate;
- changes **retention** — a new purge, a changed window;
- changes the **CI security posture** — rulesets, gates, branch protection;
- resolves or introduces an entry under **Known gaps & accepted risks**.

Then bump **Last reviewed** at the top.

When a control is removed, **delete its entry** — a security doc describing
controls that no longer exist is worse than no doc at all.
