# Security Features

A living inventory of every security control in this app — what it does, where
it lives, and why. **Maintained over time**; see [Keeping this current](#keeping-this-current).

**Last reviewed: 2026-07-28**

Related: [`ARCHITECTURE.md`](./ARCHITECTURE.md) · [`../CLAUDE.md`](../CLAUDE.md) · [`password-reset-hardening.md`](./password-reset-hardening.md)

---

## At a glance

| Area | Posture |
|---|---|
| Authentication | Auth.js v5, Credentials + JWT, bcrypt cost 12, live session revocation, 10h absolute / 4h idle |
| Authorization | Role-based (`ADMIN`/`USER`), enforced per-route, re-read from the DB every request |
| Public surface | Enumerable **by design**, behind a shared 8-digit PIN gate |
| Secrets | All via env; sensitive modules marked `server-only` |
| Database | RLS deny-all, but **app-layer is the real boundary** |
| CI | Semgrep SAST + build + security-docs check, all three required to merge to `main` |
| Accountability | Receipts sealed + attributed; **server-attested, not user non-repudiation** |
| Rate limiting | Composite `(IP, email)`: 5 auth failures / 15 min under a 60 / IP ceiling; 100 requests / min; global botnet detector |
| Bot defence | Cloudflare Turnstile on login + reset (config-gated); anonymous non-browser agents refused |
| Biggest gap | **No Redis provisioned yet**, so the limiter runs per-instance |

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
> this — and that request spends the shared **anonymous** 100/min bucket
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
`requireAdmin()`** — never a bare `auth()`. Roughly 52 call sites. Throws a typed
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

---

## 3. Public surface & the PIN gate

> **Accepted requirement — do not "fix" this.** Logged-out recipients must be
> able to search, view, and download hand receipts by number/serial, and to
> search inventory and open item pages. Receipts are therefore enumerable
> (`HR-000001…`), and the public pages expose party PII, signatures, and the
> device catalog. This is intended. It can be hardened later *if the team asks*.

**An 8-digit shared PIN walls off `/`, `/i/*`, and `/receipts/*`** when
`PUBLIC_ACCESS_PIN_ENABLED` is on. Logged-in users bypass it. This is a
**non-authz gate** — it checks a PIN cookie or a session; `requireUser` /
`requireAdmin` remain the real boundary. `src/proxy.ts`

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

**21 files carry `import "server-only"`** — including `authz.ts`, `password.ts`,
`crypto.ts`, `reset-token.ts`, `password-reset.ts`, and `public-access.ts`. A
client-side import of any of them becomes a build error.

**No hardcoded credentials.** Everything via `process.env`: `DATABASE_URL`,
`AUTH_SECRET`, `CRON_SECRET`, `SIGNING_PRIVATE_KEY`, `APP_URL`,
`PUBLIC_ACCESS_PIN_ENABLED`, `ADMIN_INBOX_EMAIL`.

**The signing key is never logged** — failure paths in `src/lib/crypto.ts` log
the error, never the key.

**Queries `select` only the columns the view renders.** Signature blobs and PII
must never enter list, search, or type-ahead queries.

**Clients get generic errors; servers get the stack trace.** e.g.
`"Something went wrong. Please try again."` to the user, full `console.error`
server-side.

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

**The comparison is constant-time** (`timingSafeEqual`), with a length check
first so a mismatched length is rejected without comparing.

**It fails closed** — an unconfigured `CRON_SECRET` rejects everything rather
than leaving the endpoint open.

**Never cached, Node runtime** (`dynamic = "force-dynamic"`) — it mutates data
and must run fresh on every invocation.

**Errors don't leak internals** — generic `"Purge failed"` plus a server log.

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

**An `xhigh` review marker is required before pushing** — per-commit, so a new
commit needs a fresh review. Note this is a **Claude Code hook**
(`.claude/hooks/xhigh-review-gate.sh`), so it constrains agent tool calls, not a
human pushing from their own terminal. There are no git hooks installed.

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

**Two policies, both keyed on client IP.** `src/lib/rate-limit.ts`

| Policy | Budget | Keyed on | Applies to |
|---|---|---|---|
| `AUTH_POLICY` | **5 per 15 min** | scope + IP + **submitted email** | sign-in, password-reset request |
| `AUTH_POLICY` | **5 per 15 min** | scope + IP | reset submission, PIN unlock, `POST /api/auth/*` (no identity available) |
| `AUTH_SPRAY_POLICY` | **60 per 15 min** | scope + IP | the ceiling over the two identity-keyed surfaces above |
| `API_POLICY` | **100 per min** | IP | `GET /api/auth/*`, plus `/api/*` and the public PII surface (`/`, `/i/*`, `/receipts/*`) **for anonymous callers only** |
| `AUTH_VELOCITY_POLICY` | **100 per 5 min** | one global key | every failed credential check, app-wide — the botnet detector |

**Auth buckets are composite: `(scope, network, account)`, under a per-network
ceiling.** Neither half works alone. A purely per-IP limit punishes the wrong
people — the service desk shares one NAT egress IP, so one person mistyping
their password five times would lock out every colleague. A purely composite key
is not a limit at all — the email is supplied by whoever is submitting the form,
so rotating it mints a fresh 5-attempt bucket and one host could spray thousands
of accounts. Together: five failures per account per network, under twenty
failures per network. The email is **hashed** (`rateLimitIdentity`, SHA-256
truncated to 64 bits) before it becomes a key — "who tried to sign in as whom"
must not sit in a third-party Redis or a log line — and normalised first, so
capitalisation is not a fresh budget.

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

**Sign-in has ONE budget across two surfaces.** `loginAction` and the proxy's
`/api/auth/*` mutation gate share the `"login"` scope. `POST
/api/auth/callback/credentials` is a working sign-in path, so separate scopes
would have meant ten guesses per window while this table said five.

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
  the composite key exists to prevent. If the ceiling then refuses, the narrow
  token is handed back: the account did not get its attempt.
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

**Where.** The two unauthenticated forms that do work for an anonymous caller:
`/login` and `/forgot-password`. `src/components/TurnstileWidget.tsx` renders the
widget; `loginAction` and `requestPasswordResetAction` verify the token
server-side against `challenges.cloudflare.com/turnstile/v0/siteverify`.
`src/lib/turnstile.ts`

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

---

## Known gaps & accepted risks

Tracked deliberately, so nobody re-discovers them as new findings.

**0. The bot defences are config-gated and spoofable, in that order.**
⚠️ *Owed to a human: provision the Turnstile keys.*
Until `NEXT_PUBLIC_TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET_KEY` are set, no
CAPTCHA runs ([§13](#13-captcha--cloudflare-turnstile)) — and because Turnstile
is what the botnet detector escalates to, the detector is **alerting only**, not
a mitigation. Separately, the User-Agent filter ([§12](#12-rate-limiting)) is
defeated by one line in a scraper; it is deliberately a coarse filter for the
lazy majority, not a control, and it must never be the thing something else
relies on.

**1. Rate limiting is only as good as the store behind it, and it fails open.**
⚠️ *Owed to a human: provision the Redis store.*
[§12](#12-rate-limiting) ships the limiter and every call site, but until a
Marketplace Redis integration is attached to the Vercel project
(`KV_REST_API_URL` / `KV_REST_API_TOKEN`), production runs the **per-instance
in-memory fallback**, which throttles only requests that happen to land on the
same warm lambda. Two further accepted properties, both deliberate: a Redis
outage **allows** traffic rather than locking the desk out, and the identifier
is the client IP taken from `x-vercel-forwarded-for` / `x-real-ip` /
`x-forwarded-for` — forgeable if this app is ever served without a proxy that
overwrites those headers, and shared by everyone behind one NAT egress.

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

**The watch list is at the top of `scripts/check-security-docs.mjs`.** It
currently covers `authz.ts`, `auth.ts`, `proxy.ts`, `password.ts`,
`password-reset.ts`, `reset-token.ts`, `actions/auth.ts`, `public-access*.ts`,
`crypto.ts`, `email.ts`, `api/cron/**`, `next.config.ts`, and `ci.yml`.
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
