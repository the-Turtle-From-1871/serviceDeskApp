# Deploying Hand Receipt (Vercel + Neon)

The app is a Next.js 16 server app backed by Postgres. Hosting has two parts:
**Vercel** runs the app, **Neon** provides the database.

## 1. Push the repo to GitHub

```bash
git remote add origin git@github.com:<you>/hand-receipt.git
git push -u origin feat/hand-receipt-app   # or merge to main first and push main
```

## 2. Create the database (Neon)

1. Create a project at https://neon.tech (free tier is fine).
2. From the dashboard, copy **two** connection strings for your database:
   - **Pooled** — host contains `-pooler` → this is `DATABASE_URL` (app runtime).
   - **Direct** — host without `-pooler` → this is `DIRECT_URL` (migrations only).
   Both should end with `?sslmode=require`.

## 3. Apply migrations + seed the admin (one time)

Run locally, pointed at Neon (does not touch your dev DB):

```bash
# bash / macOS / Linux
DIRECT_URL="<neon-direct-url>" DATABASE_URL="<neon-pooled-url>" npm run db:deploy
DATABASE_URL="<neon-pooled-url>" SEED_ADMIN_EMAIL="admin@yourorg.com" SEED_ADMIN_PASSWORD="<strong-password>" npm run db:seed
```

```powershell
# Windows PowerShell
$env:DIRECT_URL="<neon-direct-url>"; $env:DATABASE_URL="<neon-pooled-url>"; npm run db:deploy
$env:SEED_ADMIN_EMAIL="admin@yourorg.com"; $env:SEED_ADMIN_PASSWORD="<strong-password>"; npm run db:seed
```

> The app has no password-reset UI yet, so set `SEED_ADMIN_PASSWORD` to a strong
> value here — that is the admin's real password.

## 4. Import the project in Vercel

1. https://vercel.com → **Add New… → Project** → import the GitHub repo.
2. Framework is auto-detected as Next.js. Leave the build command as-is
   (`package.json` runs `prisma generate && next build`).
3. Add **Environment Variables** (Production):

   | Name           | Value                                             |
   |----------------|---------------------------------------------------|
   | `DATABASE_URL` | Neon **pooled** URL (`?sslmode=require`)          |
   | `DIRECT_URL`   | Neon **direct** URL (`?sslmode=require`)          |
   | `AUTH_SECRET`  | a fresh secret — run `npx auth secret`            |
   | `APP_URL`      | your deployed URL, e.g. `https://<app>.vercel.app`|

4. **Deploy.** First deploy: you may not know the final URL yet — deploy once,
   copy the assigned domain into `APP_URL`, then redeploy so QR codes encode it.

## 5. Verify

- Visit the site → you should be redirected to `/login`.
- Sign in with the seeded admin, create an item, print its QR, and scan it with a
  phone → it should open `https://<APP_URL>/i/<id>`.

## Notes / caveats

- **Change the admin password**: there is no in-app password change yet; the
  seeded value is the live password. Seed with a strong one (step 3).
- **Migrations on later schema changes**: re-run `npm run db:deploy` with the
  Neon URLs (the app build does *not* auto-migrate, by design).
- **Pooled vs direct**: the app must use the pooled URL (serverless opens many
  connections); migrations must use the direct URL. Mixing them up is the most
  common failure.
- This is custody data — keep it behind auth, on HTTPS (Vercel provides it), and
  don't commit real `.env` files (`.env*` is git-ignored except `.env.example`).
