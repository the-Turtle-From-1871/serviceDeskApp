# Security Features

A living inventory of every security control in this app — what it does, where
it lives, and why. **Maintained over time**; see [Keeping this current](#keeping-this-current).

**Last reviewed: 2026-07-28**

Related: [`ARCHITECTURE.md`](./ARCHITECTURE.md) · [`../CLAUDE.md`](../CLAUDE.md) · [`password-reset-hardening.md`](./password-reset-hardening.md)

---

## At a glance

| Area | Posture |
|---|---|
| Authentication | Auth.js v5, Credentials + JWT, bcrypt cost 12, live session revocation |
| Authorization | Role-based (`ADMIN`/`USER`), enforced per-route, re-read from the DB every request |
| Public surface | Enumerable **by design**, behind a shared 8-digit PIN gate |
| Secrets | All via env; sensitive modules marked `server-only` |
| Database | RLS deny-all, but **app-layer is the real boundary** |
| CI | Semgrep SAST + build, both required to merge to `main` |
| Accountability | Receipts sealed + attributed; **server-attested, not user non-repudiation** |
| Biggest gap | **No IP-based rate limiting** |

Jump to: [1 Authentication](#1-authentication) · [2 Authorization](#2-authorization) ·
[3 Public surface](#3-public-surface--the-pin-gate) · [4 Password reset](#4-password-reset) ·
[5 Injection](#5-injection--output-safety) · [6 Secrets](#6-secrets--data-leakage) ·
[7 Receipt seal](#7-cryptographic-receipt-seal) · [8 Cron](#8-background-jobs-cron) ·
[9 Retention](#9-data-retention--minimization) · [10 Database](#10-database-posture) ·
[11 CI/CD](#11-supply-chain--cicd) · [Known gaps](#known-gaps--accepted-risks)

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
`deviceName` / `homeUnit` / `notes` are admin-only. `updateItemDetailsAction`
**picks the Zod schema by role**, so a crafted POST can't widen the field set.

**Readiness edits live in their own admin-only action** (`markItemsReadyAction`,
the "Mark as on hand" button) rather than being folded into
`updateItemDetailsAction` — that keeps the USER-editable field set exactly as
narrow as it was. It stamps `markedReadyAt` and nothing else; readiness itself
is derived, so there is no state a POST could assert.

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

**A refused cookie is expired in the browser** — the proxy attaches a
`cookies.delete()` to the `/unlock` redirect, so a cookie the ceiling retired is
not resent on every subsequent request until its own longer expiry.
`src/proxy.ts`

**The signature compare is constant-time** — length-checked, no early exit, so it
leaks no timing information. `safeEqual()`

**The HMAC verify is skipped when it can't change the outcome** — it runs only
when the flag is on *and* the user isn't logged in. `src/proxy.ts:42`

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
> **Gap, owed to a human:** no IP-based or global rate limiting. See
> [Known gaps](#known-gaps--accepted-risks).

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

**`main` is branch-protected** — both checks required, `strict` mode (the branch
must be up to date). Admin bypass exists for emergencies only.

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

## Known gaps & accepted risks

Tracked deliberately, so nobody re-discovers them as new findings.

**1. No IP-based or global rate limiting.** ⚠️ *Owed to a human.*
Login and password reset have only the per-account cooldown — nothing throttles
distributed abuse or enumeration probing. A real limiter (Upstash/Redis or an
edge throttle) is infrastructure work and remains outstanding.

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
