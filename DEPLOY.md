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
