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

4. **Deploy.** First deploy: you may not know the final URL yet — deploy once,
   copy the assigned domain into `APP_URL`, then redeploy so QR codes encode it.

## 5. Verify

- Visit the site → you should be redirected to `/login`.
- Sign in with the seeded admin, create an item, print its QR, and scan it with a
  phone → it should open `https://<APP_URL>/i/<id>`.

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
