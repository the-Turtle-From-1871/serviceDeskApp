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

> The app has no password-reset UI yet, so set `SEED_ADMIN_PASSWORD` to a strong
> value here — that is the admin's real password.

## 4. Import the project in Vercel

1. https://vercel.com → **Add New… → Project** (import the GitHub repo) or run
   `npx vercel` from the project root.
2. Framework is auto-detected as Next.js. Leave the build command as-is
   (`package.json` runs `prisma generate && next build`).
3. Add **Environment Variables** (Production):

   | Name           | Value                                                   |
   |----------------|---------------------------------------------------------|
   | `DATABASE_URL` | Supabase **transaction pooler** URL (6543, `pgbouncer=true`) |
   | `DIRECT_URL`   | Supabase **session/direct** URL (5432)                  |
   | `AUTH_SECRET`  | a fresh secret — run `npx auth secret`                  |
   | `APP_URL`      | your deployed URL, e.g. `https://<app>.vercel.app`      |
   | `CRON_SECRET`  | long random value (`openssl rand -hex 32`) — authenticates the purge cron (see §6) |

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

4. **Deploy.** First deploy: you may not know the final URL yet — deploy once,
   copy the assigned domain into `APP_URL`, then redeploy so QR codes encode it.

## 5. Verify

- Visit the site → you should be redirected to `/login`.
- Sign in with the seeded admin, create an item, print its QR, and scan it with a
  phone → it should open `https://<APP_URL>/i/<id>`.

## 6. Background data purge (automatic cleanup)

A scheduled worker permanently deletes stale records:

- **Closed receipts** — 90 days after a receipt (`Transfer`) is closed.
- **Deactivated accounts** — 3 months after a user is deactivated. Users still
  referenced by items/receipts are **skipped** (reported as `skippedCount`), never
  force-deleted.

**How it runs.** `vercel.json` defines a Vercel Cron that calls
`/api/cron/purge` daily at **08:00 UTC**. The endpoint has no user session, so it
authenticates with a shared secret instead:

- Set `CRON_SECRET` (Production env, step 4) to a long random value —
  `openssl rand -hex 32`. Vercel automatically attaches it as
  `Authorization: Bearer <CRON_SECRET>` on scheduled calls.
- If `CRON_SECRET` is **unset**, the endpoint fails closed (every call → `401`)
  and **nothing is ever purged** — a silent no-op. Setting it is required for the
  cleanup to happen at all.
- Vercel runs Crons on a schedule only on **Pro** plans. On Hobby, the schedule
  won't auto-fire — trigger it manually (below).

**Trigger it manually** — the same call the scheduler makes. Replace
`<CRON_SECRET>` with the value from Vercel (do **not** hardcode the secret into
committed scripts), and `<APP_URL>` with the deployed domain:

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
{"ok":true,"transfers":{"deletedCount":0},"users":{"deletedCount":0,"skippedCount":0}}
```

- `deletedCount` — records permanently removed on this run.
- `skippedCount` — accounts old enough to purge but kept because they still have
  attached items/receipts.
- A wrong or missing secret returns `401` and touches nothing.

> ⚠️ This endpoint **permanently deletes** eligible data — there is no undo. It is
> safe to call anytime (it only removes records past their retention window) but it
> is **not** a dry run. The route is intentionally excluded from the auth
> middleware (`src/proxy.ts` matcher) so the cron isn't redirected to `/login`;
> its only protection is `CRON_SECRET`, so keep that value secret.

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
- `200` — the import ran, with a JSON summary: `added`, `updated`, `unchanged`,
  `detected`, `skipped`, `unresolved`, `mismatches`.
- `401` — missing or wrong secret.
- `400` — the file isn't named `*.csv`, or it couldn't be parsed.
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

Invoke-RestMethod -Uri "https://servicedeskapp.vercel.app/api/items/import" `
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
about twenty, not by two thousand. The function is allowed 300s and the
transaction inside it 55s, which is a wide margin — but measure it in step 2
rather than trusting this paragraph.

**If it does time out**, the symptom is a `500` with nothing written (the
transaction aborts as a unit). The fix is to split the export into smaller
files, which is safe precisely because nothing is ever deleted and re-importing
unchanged rows is a no-op.

**What to do if the numbers look wrong.** Every field the import changes is
recorded in that item's edit history, attributed to `MDM Import (automated)`,
so you can see exactly what a run touched from the item's own page — and
nothing is ever deleted, so a bad import is a correction, never a loss.

## Notes / caveats

- **Change the admin password**: there is no in-app password change yet; the
  seeded value is the live password. Seed with a strong one (step 3).
- **Prepared statements**: we use Prisma's `pg` driver adapter, which is safe
  with Supabase's transaction pooler. If you ever see a "prepared statement
  already exists" error, point `DATABASE_URL` at the **session pooler** (5432)
  instead — no code change needed.
- **Migrations on later schema changes**: re-run `npm run db:deploy` with the
  Supabase URLs (the app build does *not* auto-migrate, by design).
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
