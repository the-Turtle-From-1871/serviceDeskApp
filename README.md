# Hand Receipt

A web app that digitizes hand receipts — tracking custody of equipment through a
signed, auditable transfer chain. Admins log items and generate QR codes;
holders transfer items to one another, and the recipient **signs** to accept
custody. Every transfer can be exported as a filled **DA Form 2062** hand
receipt PDF.

> This is not a stock create-next-app. See [`AGENTS.md`](./AGENTS.md) — this
> Next.js version has breaking changes; read `node_modules/next/dist/docs/`
> before writing framework code.

## Features

- **Item registry** — make, model, serial number, asset tag, home location, notes; ACTIVE/RETIRED status.
- **QR codes** — each item has a public read-only page (`/i/[itemId]`); QR is printable and downloadable as a PDF.
- **Signed custody chain** — holder initiates a transfer, recipient draws a signature to accept; custody moves only on signature.
- **Admin console** — create/edit/retire items, manage users (create, set role, activate/deactivate), force-reassign (override), full audit log.
- **DA Form 2062 hand receipt** — every completed transfer exports a filled, flattened DA 2062 PDF with a vertical recipient signature + date in the quantity column and a custody-record page.
- **Roles** — `ADMIN` and `USER`, enforced server-side; deactivations/role changes take effect on the next request.
- **HST everywhere** — all timestamps display in Hawaii Standard Time (stored as UTC).

## Tech stack

- **Next.js 16** (App Router, Server Components, Server Actions, Route Handlers) · **React 19** · **TypeScript 5** · Turbopack
- **PostgreSQL** (Supabase in prod, Docker `postgres:16` locally) via **Prisma 7** with the **`@prisma/adapter-pg`** driver over **`pg`**
- **Auth.js v5** (Credentials + JWT sessions) · **bcryptjs**
- **Zod** validation · **pdf-lib** (PDFs) · **qrcode**
- **Vitest** (real-DB integration tests) · **Playwright** · **ESLint 9**
- Hosted on **Vercel** + **Supabase**

Full rationale and diagrams: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

## Local development

Prerequisites: Node ≥20, Docker.

```bash
# 1. Install deps
npm install

# 2. Start Postgres (docker-compose.yml → postgres:16 on port 5435)
docker compose up -d

# 3. Configure env
cp .env.example .env
#   set AUTH_SECRET:  npx auth secret
#   DATABASE_URL / APP_URL already point at the local DB / localhost

# 4. Apply migrations and seed an admin
npm run db:migrate
npm run db:seed        # admin@example.com / ChangeMe123!  (override via SEED_ADMIN_*)

# 5. Run
npm run dev            # http://localhost:3000
```

The test suite uses a separate `handreceipt_test` database on the same server;
create it once with `CREATE DATABASE handreceipt_test;`.

## Environment variables

| Var            | Purpose                                                            |
|----------------|-------------------------------------------------------------------|
| `DATABASE_URL` | App runtime connection (pooled in prod). Read by the pg adapter.   |
| `DIRECT_URL`   | Direct connection for `prisma migrate deploy` (prod only).         |
| `AUTH_SECRET`  | Signs Auth.js JWTs. Generate with `npx auth secret`.               |
| `APP_URL`      | Absolute base URL, used to build scannable QR links.               |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | Optional overrides for the seeded admin. |

`.env*` is git-ignored except `.env.example`.

## Scripts

| Script            | Description                                  |
|-------------------|----------------------------------------------|
| `npm run dev`     | Dev server (Turbopack)                        |
| `npm run build`   | `prisma generate && next build`               |
| `npm start`       | Production server                             |
| `npm test`        | Vitest suite (needs the test DB up)           |
| `npm run db:migrate` | `prisma migrate dev` (local)               |
| `npm run db:deploy`  | `prisma migrate deploy` (prod)             |
| `npm run db:seed`    | Seed the admin account                     |
| `npm run db:reset`   | Reset the local dev DB                     |
| `npm run lint`    | ESLint                                        |

## Project structure

```
src/
  app/                 # App Router routes
    actions/           # user-facing server actions (auth, transfers, account)
    admin/             # admin console + admin/actions server actions
    i/[itemId]/        # public read-only item page
    transfers/[id]/    # sign screen + receipt PDF route handler
    api/auth/          # Auth.js route handlers
  components/          # shared UI (server + client components)
  lib/                 # prisma, authz, password, datetime helpers
  modules/             # domain services
    items/  transfers/  users/  receipts/
  auth.ts              # Auth.js config
  proxy.ts             # coarse auth gate (Next 16 middleware, Node runtime)
prisma/                # schema, migrations, seed
tests/                 # test helpers (db reset/migrate, factories)
docs/                  # architecture + design notes
```

## Auth & roles (summary)

Email + password only, no open signup — admins provision accounts. Sessions are
JWT (no DB session table). Authorization is enforced in `requireUser` /
`requireAdmin`, which re-read `role`/`isActive` from the DB each request, so
deactivations and role changes take effect immediately. See
[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the full model and **why we
use Auth.js rather than Supabase Auth**.

## Testing

Vitest runs against a **real migrated Postgres** (`handreceipt_test`), truncating
between tests — services and custody invariants are covered with behavior, not
mocks. Playwright is used for browser/e2e verification.

## Deployment

Hosted on **Vercel** (app) + **Supabase** (Postgres). Full steps — connection
strings, env vars, migrations, and the Vercel-Hobby commit-author-email
requirement — are in [`DEPLOY.md`](./DEPLOY.md).

## Known gaps / roadmap

- No self-serve password reset yet; an admin "reset password" action is a natural next step.
- FROM/TO on the DA 2062 use a user's name only (no rank/unit fields on profiles yet).
