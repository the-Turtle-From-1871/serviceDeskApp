# Deploying Hand Receipt (Vercel + Supabase)

The app is a Next.js 16 server app backed by Postgres. Hosting has two parts:
**Vercel** runs the app, **Supabase** provides the Postgres database (and a
dashboard for ongoing management).

> The app talks to Supabase as a plain Postgres via Prisma — it does **not** use
> Supabase Auth/Storage. Authentication and roles are handled in-app by Auth.js.

## 1. The repo

Already on GitHub (private). Vercel can deploy from GitHub, or from your local
machine with `npx vercel` — either works.

## 2. Create the database (Supabase)

1. Create a project at https://supabase.com (free tier is fine). Pick a region
   close to your Vercel region and set a strong **database password**.
2. Open **Project Settings → Database → Connection string** (the "Connect"
   dialog) and copy **two** strings:
   - **Transaction pooler** (port **6543**) → this is `DATABASE_URL`. Append
     `?pgbouncer=true` if it isn't already there.
   - **Session pooler / direct** (port **5432**) → this is `DIRECT_URL`.

   Both come pre-filled with your project ref and use SSL.

## 3. Apply migrations + seed the admin (one time)

Run locally, pointed at Supabase (does not touch your dev DB):

```bash
# bash / macOS / Linux
DIRECT_URL="<supabase-5432-url>" DATABASE_URL="<supabase-6543-url>" npm run db:deploy
DATABASE_URL="<supabase-6543-url>" SEED_ADMIN_EMAIL="admin@yourorg.com" SEED_ADMIN_PASSWORD="<strong-password>" npm run db:seed
```

```powershell
# Windows PowerShell
$env:DIRECT_URL="<supabase-5432-url>"; $env:DATABASE_URL="<supabase-6543-url>"; npm run db:deploy
$env:SEED_ADMIN_EMAIL="admin@yourorg.com"; $env:SEED_ADMIN_PASSWORD="<strong-password>"; npm run db:seed
```

> Set `SEED_ADMIN_PASSWORD` to a strong value here — it is the admin's real
> password from first sign-in. It *can* be changed afterwards (`/account` →
> Change password, or `/forgot-password` once email is configured), but the
> seeded value is live in the meantime, so don't seed a placeholder.

## 4. Import the project in Vercel

1. https://vercel.com → **Add New… → Project** (import the GitHub repo) or run
   `npx vercel` from the project root.
2. Framework is auto-detected as Next.js. Leave the build command as-is
   (`package.json` runs `copy-wasm && prisma generate && next build`).
3. Add **Environment Variables** (Production):

   | Name           | Value                                                   |
   |----------------|---------------------------------------------------------|
   | `DATABASE_URL` | Supabase **transaction pooler** URL (6543, `pgbouncer=true`) |
   | `DIRECT_URL`   | Supabase **session/direct** URL (5432)                  |
   | `AUTH_SECRET`  | a fresh secret — run `npx auth secret`. **Rotating it is no longer a cheap operation** — besides signing out every session and retiring every unlock cookie, it also signs the per-receipt link token baked into every notification email already sent and every QR already printed on a handed-out DA 2062 (`src/modules/receipts/render.ts`). Rotation permanently breaks all of those: paper in someone's hand cannot be re-issued, and there is no per-receipt revocation (`docs/SECURITY.md`, Known gap 12). |
   | `APP_URL`      | the **custom domain**, `https://www.dcsim.us` — see the warning below |
   | `CRON_SECRET`  | long random value (`openssl rand -hex 32`) — authenticates the purge cron (see §6) |

   🚨 **`APP_URL` must NOT be a `vercel.app` URL in production.** Mail to
   `army.mil` was being dropped with no bounce and no signal; a controlled
   four-message test proved the cause was the **link in the message body**, not
   the sender, DKIM or SPF — plain text, a `dcsim.us` link and a PDF attachment
   all arrived, and only the message carrying a `vercel.app` URL vanished. The
   government network filters that domain. `APP_URL` is what builds every link
   in a custody email (and every QR code), so pointing it at the Vercel domain
   silently breaks receipt delivery to the people the app exists for. Any link
   in an email must come from `defaultBaseUrl()` (`src/lib/base-url.ts`), never
   a hardcoded deploy URL.

   Transactional email — the app sends hand receipts, returns, pickup notices,
   password resets and overdue alerts, so this is not optional in practice:

   | Name           | Value                                                   |
   |----------------|---------------------------------------------------------|
   | `GMAIL_USER` / `GMAIL_APP_PASSWORD` | **Retired — delete them from Vercel if present.** These drove the old SMTP app-password transport, removed with `nodemailer` on 2026-08-04. They are now inert: `getEmailSender` ignores them entirely, and `src/lib/email.test.ts` pins that it must, so a stale value cannot silently resurrect the old path. Left set, they do nothing except mislead the next reader. |
   | `GMAIL_FROM` / `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` / `GMAIL_REFRESH_TOKEN` | The Gmail API sender (OAuth2, scope `gmail.send`). **All four or none** — a partial set falls through to the next sender. Be aware what "the next sender" means with Resend unset: the **log-only stub**, which prints whole message bodies — including password-reset links and receipt-link tokens — into the platform log, and delivers nothing. A partial set is therefore worse than none. The consent screen is kept in *Testing* status, so Google expires the grant every ~7 days and the refresh token must be re-minted and pushed to Vercel; `scripts/gmail-token-rotation` automates that (see the note in §Notes). |
   | `RESEND_API_KEY` / `EMAIL_FROM` | The alternative sender, used only when the Gmail vars are absent. Both required. |
   | `RECEIPT_CC_EMAILS` | Comma-separated record copies on every custody email. **Unset is not "off"** — it uses the built-in defaults in `src/lib/email-recipients.ts`. Set it to an empty value to actually disable the copies. |
   | `ADMIN_INBOX_EMAIL` | Extra copy on new receipts and returns, and the destination for overdue alerts. **Unset means the nightly overdue sweep sends nothing and stamps nothing.** |
   | `G6_SERVICE_DESK_EMAIL` | Extra copy on return notifications (partial and full). |

   With no sender configured at all, mail is written to the server log and
   nothing is queued or retried — receipts appear to send and never arrive.

   ⚠️ **A refreshed `GMAIL_REFRESH_TOKEN` needs a REDEPLOY to take effect** —
   setting it in the dashboard and walking away leaves the running deployment on
   the dead token and outbound mail stays broken. This is exactly what
   `scripts/gmail-token-rotation` fires a Deploy Hook for; doing it by hand means
   updating the value *and* redeploying.

   Optional, but both are **owed** before this is really hardened — see
   [`docs/SECURITY.md`](docs/SECURITY.md) Known gaps #0 and #1:

   | Name           | Value                                                   |
   |----------------|---------------------------------------------------------|
   | `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Injected automatically by attaching a **Redis integration from the Vercel Marketplace** (Storage → Marketplace → any Redis provider). Until then the rate limiter counts per serverless instance instead of fleet-wide. Vercel's own KV product is retired; the Marketplace integration replaces it. |
   | `NEXT_PUBLIC_TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | A Cloudflare Turnstile site + secret key. **Both or neither** — with one missing the challenge is neither rendered nor verified. The distributed-attack detector escalates *to* Turnstile, so without keys it can alert but cannot act. |

   ⚠️ **Turnstile needs a REDEPLOY, not just an env change.** `NEXT_PUBLIC_*`
   variables are inlined at build time — into the server bundle as well as the
   browser one — so setting the two keys in Vercel and walking away leaves the
   running server reading `undefined` for the site key: no widget renders,
   verification reports "skipped", and the challenge is silently OFF with
   nothing logged. Trigger a new deployment after setting them, then confirm the
   widget appears on `/login`. (Redis is different: `KV_REST_API_*` are read at
   request time, so those take effect on the next request.)

   Also optional, but decide about them deliberately rather than by omission:

   | Name           | Value                                                   |
   |----------------|---------------------------------------------------------|
   | `SIGNING_PRIVATE_KEY` | Ed25519 PKCS#8 PEM that signs each receipt's tamper-evidence seal. Paste the multi-line PEM as-is into Vercel. Unset means receipts are created **unsealed** — silently, and not retroactively fixable for receipts already written. See [`docs/SECURITY.md` §7](docs/SECURITY.md#7-cryptographic-receipt-seal). |
   | `PUBLIC_ACCESS_PIN_ENABLED` | `"true"` puts an admin-set 8-digit PIN in front of `/i/*` and `/receipts/<n>` for logged-out visitors. `/` stays open (Google's OAuth branding review requires a publicly readable home page). The PIN itself is set in-app at `/admin`, stored bcrypt-hashed. |
   | `MDM_IMPORT_SECRET` | Bearer secret for the machine-driven import endpoint — see §7. |
   | `RATE_LIMIT_DISABLED` | **Never set this in a deployed environment.** It turns off the rate limiter *and* the browser check. Local work only. |

4. **Deploy.** Then point the custom domain at the project and set `APP_URL` to
   it (`https://www.dcsim.us`), and redeploy so QR codes and email links encode
   the right origin. Do not leave `APP_URL` on the assigned `*.vercel.app`
   domain — see the warning in step 3.

## 5. Verify

- Visit the site → you should be redirected to `/login`.
- Sign in with the seeded admin, create an item, print its QR, and scan it with a
  phone → it should open `https://<APP_URL>/i/<id>`.
- Build a hand receipt to a real address and confirm the message **arrives**,
  not just that the app reports success. With no sender configured the send is
  logged and swallowed, and a `vercel.app` link in the body makes the message
  disappear for `.mil` recipients with no bounce.

## 6. Nightly maintenance worker (purge + overdue alerts)

One scheduled endpoint does four things in a single run:

- **Purge closed receipts** — 90 days after a receipt (`Transfer`) is closed.
- **Purge deactivated accounts** — 3 months after a user is deactivated. Users
  still referenced by items/receipts are **skipped** (reported as
  `skippedCount`), never force-deleted.
- **Alert on overdue hand receipts** — one email to `ADMIN_INBOX_EMAIL` per open
  receipt whose return deadline has lapsed, stamped so it never re-alerts.
- **Alert on overdue service-queue items** — the same, for pending service work
  past its deadline.

**How it runs: GitHub Actions, not Vercel Cron.** `.github/workflows/purge-cron.yml`
curls `/api/cron/purge` daily at **08:23 UTC** and fails the workflow run on any
non-`200` or a body without `"ok":true` — so a broken secret is visible in the
Actions tab instead of silent.

There is **no `vercel.json` and no Vercel Cron.** Vercel only runs Crons on a
schedule on **Pro** plans; on Hobby the schedule never fired and the purge
silently never ran, which is why this moved to Actions. Don't "restore" a
`vercel.json` cron — it would double-run the sweep on Pro and do nothing on Hobby.

The endpoint has no user session, so it authenticates with a shared secret:

- Set `CRON_SECRET` to the **same** long random value (`openssl rand -hex 32`) in
  **two** places: Vercel (Production env, step 4) and the GitHub repository
  secrets (Settings → Secrets and variables → Actions). A mismatch shows up as a
  `401` in the workflow log.
- If `CRON_SECRET` is **unset in Vercel**, the endpoint fails closed (every call
  → `401`) and **nothing is ever purged or alerted** — a silent no-op. Setting it
  is required for any of this to happen at all.
- Pushing `.github/workflows/*` needs the `workflow` token scope
  (`gh auth refresh -s workflow`); a plain `repo`-scoped token is rejected.

**Trigger it manually** — or just run the workflow from the Actions tab
(**Nightly purge (cron)** → *Run workflow*, which `workflow_dispatch` enables).
By hand it is the same call the scheduler makes; the route accepts `GET` (what
the workflow sends) and `POST` alike. Replace `<CRON_SECRET>` with the value from
Vercel (do **not** hardcode the secret into committed scripts), and `<APP_URL>`
with the deployed domain:

```bash
# bash / macOS / Linux
curl -s -X POST https://<APP_URL>/api/cron/purge \
  -H "Authorization: Bearer <CRON_SECRET>"
```

```powershell
# Windows PowerShell
Invoke-RestMethod -Method Post -Uri "https://<APP_URL>/api/cron/purge" `
  -Headers @{ Authorization = "Bearer <CRON_SECRET>" }
```

Success is HTTP `200` with a JSON summary:

```json
{"ok":true,"transfers":{"deletedCount":0},"users":{"deletedCount":0,"skippedCount":0},"alerts":{"overdueTransfers":0,"overdueService":0}}
```

- `deletedCount` — records permanently removed on this run.
- `skippedCount` — accounts old enough to purge but kept because they still have
  attached items/receipts.
- `alerts.*` — overdue emails sent this run. These stay `0` when
  `ADMIN_INBOX_EMAIL` is unset, because nothing is alerted and nothing is
  stamped — so a lapse is not "missed", it just waits for the inbox to be
  configured.
- A wrong or missing secret returns `401` and touches nothing.

> ⚠️ This endpoint **permanently deletes** eligible data — there is no undo. It is
> safe to call anytime (it only removes records past their retention window) but it
> is **not** a dry run. The route is intentionally excluded from the proxy's
> matcher (`src/proxy.ts`) so the cron isn't redirected to `/login` and isn't
> starved by a per-IP rate-limit bucket shared with unrelated traffic; its only
> protection is the constant-time `CRON_SECRET` compare, so keep that value
> secret.

## 7. Automated MDM import (optional)

If a technician automates a nightly Intune/MDM export, that export can be
POSTed straight into the app instead of imported by hand.

**Endpoint:** `POST /api/items/import`, `multipart/form-data`, with the CSV in
a field named `file`. Authenticate with a bearer secret:

```
Authorization: Bearer <MDM_IMPORT_SECRET>
```

**Set the secret.** Add `MDM_IMPORT_SECRET` (long random value, e.g.
`openssl rand -hex 32`) as an Environment Variable in Vercel for **both
Production and Preview**, and give the scheduled export job the same value.
Unset, the endpoint refuses every request. Rotating the value means changing
it in Vercel **and** in the scheduled job, and **requires a redeploy** to take
effect — the same non-negotiable as Turnstile in step 4, because the check
reads the value at request time from the deployed instance, but a stale
scheduled job holding the old secret will simply start getting `401`s until
it's updated too.

**Example (PowerShell, reading the secret from an environment variable rather
than hardcoding it — this is what a scheduled task should run):**

```powershell
$headers = @{ Authorization = "Bearer $env:MDM_IMPORT_SECRET" }
$form = @{ file = Get-Item .\fleet.csv }
Invoke-RestMethod -Uri "https://<APP_URL>/api/items/import" -Method Post -Headers $headers -Form $form
```

**Responses:**
- `200` — the import ran, with a JSON summary. `added`, `updated`, `unchanged`,
  and `detected` are **counts** (numbers); `skipped`, `unresolved`, and
  `mismatches` are **arrays** of per-row detail, `[]` when there's nothing to
  report — don't call `.length` on the first four or iterate the last three
  as if they were counts. Example body:

  ```json
  {
    "added": 3,
    "updated": 118,
    "unchanged": 1876,
    "detected": 12,
    "skipped": [
      { "row": 47, "serialNumber": "SN-004821", "reason": "missing make/model on a new device" }
    ],
    "unresolved": [
      { "row": 203, "deviceName": "LAPTOP-WABC01-042", "segments": ["WABC01", "042"] }
    ],
    "mismatches": [
      { "serialNumber": "SN-001177" }
    ]
  }
  ```
- `401` — missing or wrong secret.
- `400` — the file isn't named `*.csv`, it couldn't be parsed, **or it has
  more than 2000 rows** (the endpoint doesn't chunk an oversized file for
  you — split it and send multiple requests).
- `413` — the upload is too large.
- `500` — unexpected failure.

**Limits and behaviour to know before scheduling this:**
- **Maximum 2000 rows per import.** A larger export must be split into
  multiple files/requests — the endpoint doesn't chunk it for you.
- **`serialNumber` is the required column and the match key.** A serial
  already in inventory is updated in place; a serial not seen before is
  created as a new item. **Nothing is ever deleted** — a device that's missing
  from this export (decommissioned, off the network, etc.) is left untouched,
  not retired. Absence in the CSV is not a signal.
- **The import overwrites matched fields from the CSV.** For a device that
  already exists, the export is treated as the source of truth for its name,
  home unit, category and assigned user — those fields are replaced with
  whatever the CSV says, including overwriting a hand edit made in the app
  since the last import.
- **An unrecognised unit abbreviation doesn't fail the row.** That row still
  imports, just with a blank home unit, and comes back listed under
  `unresolved` in the response — not under `skipped`. Treat `unresolved` as
  "needs a look", not "didn't import."
- **A non-200 response means nothing was written.** The whole import runs as
  one transaction, so there's no partial state to reconcile — on any
  non-`200`, log the response body and re-run rather than assuming some rows
  made it in.

### 7a. Proving it works in production before you schedule it

Do not hand this to a scheduler on day one. Timings measured on a local
Postgres do not transfer — the app talks to Supabase over the network in
production, and latency is the whole question. Work through these in order.

**First, make sure all three prerequisites are actually done**, or you'll get a
confusing failure instead of a useful measurement:

1. The migration `20260730000000_import_service_account` is applied to the
   production database. Without it every request returns `500`, because there
   is no account to attribute the import to (see the note on the service
   account in `docs/SECURITY.md`).
2. `MDM_IMPORT_SECRET` is set in Vercel. On Windows, generate one with:
   ```powershell
   [Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Max 256 }))
   ```
3. The code is deployed to production.

**Step 1 — read-only dry run, no command line needed.** Open
`/admin/items/import`, choose the export, and click **Analyze** — then stop
without committing. This runs the same parse and the same database reads the
real import does and **writes nothing**. It shows the counts it would apply,
and how long it takes is your actual Supabase round-trip latency. If this feels
instant, the real import will be fine; see the note below on why.

**Step 2 — run it manually once, not on a schedule.**

```powershell
$env:MDM_IMPORT_SECRET = "<the value you set in Vercel>"

Invoke-RestMethod -Uri "https://www.dcsim.us/api/items/import" `
  -Method Post `
  -Headers @{ Authorization = "Bearer $env:MDM_IMPORT_SECRET" } `
  -Form @{ file = Get-Item .\fleet.csv }
```

Then open the Vercel dashboard, find the function invocation, and read its
**actual duration**. That is the real number — everything else is
extrapolation. A wrong or missing secret returns `401` and writes nothing, so
you cannot half-run this by fumbling the credential.

**Expect a large `updated` count on this first run, and don't read it as a
bug.** Devices currently carrying a blank home unit get one backfilled from
their device name — that is the intended fix, not runaway churn.

**Step 3 — run the exact same file again.** The importer only writes rows that
actually changed, so the second pass should be close to a no-op (`added: 0`,
`updated: 0`, most rows `unchanged`). That gives you the steady-state timing
every subsequent nightly run will look like, and confirms the import is
idempotent against unchanged input.

**Step 4 — only now hand it to the scheduler.**

**Why this should comfortably fit the budget.** The import is *round-trip
bounded, not row bounded*: a 2000-row file is roughly 15-20 database queries,
not 2000. Rows are grouped by which columns changed and written with batched
`UPDATE ... FROM (VALUES ...)` statements. So Supabase latency multiplies by
about twenty, not by two thousand. The function is allowed **60s** total; the
database transaction inside it is budgeted **45s** (`maxWait` 5s + `timeout`
40s — not "the transaction" alone, `maxWait` is time spent waiting to acquire
a pool connection before the transaction even starts). That leaves roughly
**15s** outside the transaction for reading the upload, resolving the service
account, and the lookup queries that run before the transaction opens, plus
unwind time afterward — measure it in step 2 rather than trusting this
paragraph.

**If it does time out**, the symptom is a `500` with nothing written (the
transaction aborts as a unit). The fix is to split the export into smaller
files, which is safe precisely because nothing is ever deleted and re-importing
unchanged rows is a no-op.

**What to do if the numbers look wrong.** Every field the import changes is
recorded in that item's edit history, attributed to `MDM Import (automated)`,
so you can see exactly what a run touched from the item's own page — and
nothing is ever deleted, so a bad import is a correction, never a loss.

## Notes / caveats

- **Change the admin password after first sign-in**: `/account` → Change
  password. Until then the seeded value is the live password, so seed a strong
  one (step 3).
- **`main` is branch-protected, and deploys come from it.** Merging needs a PR
  with all **three** required checks green — `Semgrep SAST`, `Build (next build)`
  and `Security docs current` (`.github/workflows/ci.yml`; the first two run on
  push and PR, the third on PRs only because it diffs against the merge base).
  `strict` is on, so the branch must be up to date with `main`. Vercel deploys
  production on merge. Admins can bypass in an emergency
  (`enforce_admins: false`), but the default path is branch → PR → green → merge.
- **Prepared statements**: we use Prisma's `pg` driver adapter, which is safe
  with Supabase's transaction pooler. If you ever see a "prepared statement
  already exists" error, point `DATABASE_URL` at the **session pooler** (5432)
  instead — no code change needed.
- **Migrate BEFORE the merge deploys** (later schema changes): re-run
  `npm run db:deploy` with the Supabase URLs. `next build` never runs
  `migrate deploy` — by design — so merging code that `SELECT`s a column the
  production database does not have yet breaks the site the moment Vercel
  finishes deploying. Apply the migration first, then merge.
- **Pooled vs direct**: the app uses the transaction pooler (serverless opens
  many connections); migrations use the session/direct connection. Mixing them
  up is the most common failure.
- This is custody data — keep it behind auth, on HTTPS (Vercel provides it), and
  don't commit real `.env` files (`.env*` is git-ignored except `.env.example`).
- **Commit author email (Vercel Hobby)**: git deployments are blocked unless the
  commit's author email is linked to a GitHub account on the Vercel team. Use an
  email on your GitHub account (or its `ID+username@users.noreply.github.com`
  address) as `git config user.email`, otherwise pushes build-block. Direct
  `vercel --prod` CLI uploads are attributed to your Vercel user and bypass this.
- **Unattended redeploys from the Gmail token rotation tool**: if
  `scripts/gmail-token-rotation` is installed on a workstation, it fires a Deploy
  Hook every ~3 days to push a refreshed `GMAIL_REFRESH_TOKEN` into production.
  That deploys **whatever is on `main` at that moment, with nobody watching** —
  which interacts badly with the migrate-before-merge rule above. If you
  merge schema-dependent code and defer `npm run db:deploy`, the rotation will
  deploy it for you within three days. Apply migrations at merge time, not "before
  the next deploy": with this installed there is no next *manual* deploy to gate on.
  See `scripts/gmail-token-rotation/README.md`.
