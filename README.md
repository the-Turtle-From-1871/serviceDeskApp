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

- **Item registry** — make, model, serial number (**unique, case-insensitive**), device name, home unit, issuing unit (UIC), device category, current-holder email/position, notes; ACTIVE/RETIRED status. The list is **server-paginated, filterable (by UIC), and compound-sortable on every column** — including derived readiness, which is ordered in SQL rather than by a stored column. Every edit surface (new-item form, admin edit page, item detail card, identity card) suggests make/model/UIC from the fleet's own values and category/home unit from the managed lists as you type — a mobile-working combobox, not a `<datalist>` — while leaving every field free text.
- **Device categories** — admins curate the list of device classes ("Laptop", "Switch") at `/admin/categories`; removing one that items still use is refused. CSV import fills the category from a **`deviceType`** column and registers any new value automatically.
- **Operational readiness** — **derived, never stored.** An item reads `Retired` (lifecycle) → `In repair` (a pending service-queue entry) → `Deployed` (on an open, unreturned hand receipt) → `Ready to deploy` (marked on hand) → `Deployed` (carrying an MDM last-logon user) → `Untriaged`, in that precedence. The one thing an operator sets by hand is **"Mark as on hand"** — available on the items table, the item page, and automatically when a service-queue item is completed. It stamps a timestamp rather than a flag, and **MDM telemetry never overrides it**: a device on our own shelf produces logons routinely (imaging, an MDM check-in, a test before reissue), so the marking stands until a deliberate act supersedes it — an open receipt, a service flag, retirement, or an explicit clear. **Accountability is not a separate flag either** — an item counts as accounted for when an audit says so, from its most recent audit date.
- **Readiness analytics** (`/admin/analytics`, admin-only) — audit readiness (audited / overdue / never audited), fleet KPIs by category, DA 2062 volume, and a unit-allocation leaderboard. Readiness is derived live from service flags, open receipts, MDM last-logon, and the "Mark as on hand" stamp. One **Unit (UIC)** filter re-scopes the whole page; charts export to PNG/CSV or switch to a table view. The leaderboard groups by **unit name** (default) or **UIC** — two different partitions of the fleet, not two labels for one — and items with neither value show as **Unassigned** so the totals reconcile.
- **QR codes** — each item has a public read-only page (`/i/[itemId]`) reachable by scanning its label. The QR image and its printable PDF are shown to **admins only** on that page (labelling is a property-book task); admins can also print a whole sheet of labels from the items list or `/admin/items/qr-sheet`.
- **Signed custody chain** — holder initiates a transfer, recipient draws a signature to accept; custody moves only on signature.
- **Admin console** — create/edit/retire/delete items, manage users (create, set role, activate/deactivate), process property returns, work the service queue, full audit log.
- **Home units** — admins maintain the unit vocabulary at `/admin/units` (abbreviation → full name, bulk-pasteable). An item's `homeUnit` is a denormalized copy of the full name: renaming a unit backfills every item holding the old spelling, and deleting one is refused while items still carry it.
- **CSV / MDM import** — two front doors, one implementation. `/admin/items/import` is the interactive two-step flow (analyze → review → commit) that resolves unrecognised units by hand; `POST /api/items/import` is the machine-driven door for a scheduled Intune/MDM export, authenticated by a bearer `MDM_IMPORT_SECRET`. Serial number is the match key — an existing serial is updated in place, a new one is created, and **nothing is ever deleted**. See [`DEPLOY.md` §7](./DEPLOY.md).
- **Return timers and service deadlines** — an admin can put a due date on an open hand receipt (`/receipts/<n>`) and on a pending service-queue item (the item page). A nightly worker emails an overdue alert once per lapse; a blank deadline means no deadline, and is never substituted server-side.
- **Email notifications** — a new receipt, a return (partial or full) and a pickup notice each send **one** message to the customer with the signed PDF attached, copying the record addresses (`RECEIPT_CC_EMAILS`, plus the G6 desk on returns). Sent via the **Gmail API**, or Resend if the Gmail vars are unset; with neither configured mail is logged to the console instead.
- **DA Form 2062 hand receipt** — every completed transfer exports a filled, flattened DA 2062 PDF with a vertical recipient signature + date in the quantity column and a custody-record page.
- **Tamper-evidence seal** — each receipt is signed with a server-held Ed25519 key at creation (`SIGNING_PRIVATE_KEY`). An admin can re-derive the manifest from the stored receipt and verify it, which reports `VALID` / `TAMPERED` / `UNSEALED`. Best-effort: with no key configured receipts are created unsealed.
- **Accounts** — **admin-provisioned only** (no public self-registration). Rank is captured separately from name. Self-serve password reset is available (`/forgot-password`), and a signed-in user can change their own password and manage saved signatures at `/account`.
- **Roles** — `ADMIN` and `USER`, enforced server-side; deactivations/role changes take effect on the next request. A `USER` may create receipts and edit only an item's current-holder email/position — all other item fields and the service/admin queues are admin-only.
- **Sessions last one workday** — 10 hours from sign-in, or 4 hours idle, whichever comes first; then the next request goes back to the sign-in page.
- **Abuse defences** — sign-in and password reset are rate-limited per account *and* per network (5 failures per 15 minutes, under a 60-attempt network ceiling); the public pages are capped at 300 requests a minute for logged-out visitors and refuse callers that do not present as a browser; a global failed-login counter raises an alert when the whole app sees an abnormal rate. An optional **Cloudflare Turnstile** challenge sits on `/login` and `/forgot-password` once keys are configured. See [`docs/SECURITY.md` §12–13](docs/SECURITY.md#12-rate-limiting).
- **HST everywhere** — all timestamps display in Hawaii Standard Time (stored as UTC).

## Tech stack

- **Next.js 16** (App Router, Server Components, Server Actions, Route Handlers) · **React 19** · **TypeScript 5** · Turbopack
- **PostgreSQL** (Supabase in prod, Docker `postgres:16` locally) via **Prisma 7** with the **`@prisma/adapter-pg`** driver over **`pg`**
- **Auth.js v5** (Credentials + JWT sessions, 10h absolute / 4h idle) · **bcryptjs**
- **@upstash/ratelimit** + **@upstash/redis** (IP rate limiting; falls back to per-instance counters when no store is attached) · **Cloudflare Turnstile** (optional CAPTCHA)
- **Zod** validation · **pdf-lib** (PDFs) · **qrcode** · **csv-parse** (imports) · **barcode-detector** (in-browser QR scanning)
- **Gmail API** (OAuth2 refresh token, `gmail.send`) as the transactional-email sender, with **Resend** as the configured alternative — both are plain `fetch` calls, there is no SMTP client (`nodemailer` was removed on 2026-08-04)
- **Tailwind CSS v4** + **shadcn/ui** (new UI only — the original `globals.css` design system still backs existing pages; see the styling section of `CLAUDE.md`) · **Recharts** · **lucide-react**
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
#    SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD are REQUIRED — the seed throws
#    without them. There is no default admin account and no default password.
npm run db:seed

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
| `AUTH_SECRET`  | Signs Auth.js JWTs. Generate with `npx auth secret`. **Rotating it now also permanently invalidates every printed/emailed receipt QR and link** (it signs the per-receipt link token — see `DEPLOY.md` and `docs/SECURITY.md` Known gap 12), not just live sessions and unlock cookies. |
| `PUBLIC_ACCESS_PIN_ENABLED` | `"true"` gates the public PII surface (`/i/*` and `/receipts/<n>` + its PDF) behind the admin-set 8-digit PIN for logged-out users. Absent/`false` = open access. Also the kill-switch. **`/` is deliberately NOT gated** — the home page must be readable by a logged-out stranger (Google's OAuth branding review requires it); the type-ahead behind it calls `publicAccessAllowed()` itself, so the search is gated even though the page is not. |
| `APP_URL`      | Absolute base URL, used to build scannable QR links **and every link in an outbound email**. In production this must be the custom domain (`https://www.dcsim.us`) — a `vercel.app` link in a message body makes `army.mil` silently drop the mail. Falls back to Vercel's injected domain when unset — `VERCEL_PROJECT_PRODUCTION_URL`, then `VERCEL_URL` (`src/lib/base-url.ts`). Both are injected by the platform; you never set them yourself, and relying on that fallback in production is exactly the `vercel.app` failure described above. |
| `SIGNING_PRIVATE_KEY` | Ed25519 PKCS#8 PEM that signs each receipt's tamper-evidence seal. Best-effort — unset means receipts are created unsealed. Verification (admin-only) derives the public key from it; no separate public-key var. The key is server-held, so the seal attests attribution rather than proving user-level non-repudiation — see [`docs/SECURITY.md` §7](docs/SECURITY.md#7-cryptographic-receipt-seal) and Known gaps #6. |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Redis store for rate limiting, injected by a Vercel Marketplace Redis integration (`UPSTASH_REDIS_REST_*` also accepted). **Unset still works** — the limiter falls back to per-instance counters, which is fine locally and is not the production posture. |
| `RATE_LIMIT_DISABLED` | `"true"` turns off the limiter and the browser check. Local work only. |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile. **Both** required, or the challenge is not rendered and not verified. |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | Optional overrides for the seeded admin. |
| `GMAIL_FROM` / `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` / `GMAIL_REFRESH_TOKEN` | The Gmail API sender. **All four** must be set or the sender is not selected. The OAuth consent screen is kept in *Testing* status, so Google expires the grant every 7 days and `GMAIL_REFRESH_TOKEN` has to be re-minted and pushed to Vercel — a standing chore, not a misconfiguration (`scripts/gmail-token-rotation` automates it). |
| `RESEND_API_KEY` / `EMAIL_FROM` | The alternative sender, used only when the Gmail vars are absent. Both required. With neither sender configured, mail is written to the server log instead — nothing is queued or retried. |
| `RECEIPT_CC_EMAILS` | Comma-separated record copies CC'd on every custody email. **Unset uses the built-in defaults in `src/lib/email-recipients.ts` — that is not "off".** Setting it to an *empty* value is how you turn the copies off; empty and unset mean different things. |
| `ADMIN_INBOX_EMAIL` | Optional extra copy on new receipts and returns, and the destination for the overdue alerts (one email per lapsed receipt / service item). Unset means the nightly sweep stamps nothing and sends nothing. |
| `G6_SERVICE_DESK_EMAIL` | Optional extra copy on return notifications (partial and full). |
| `CRON_SECRET` | Bearer secret for `/api/cron/purge` (the nightly purge + overdue-alert worker). Unset = the endpoint fails closed and **nothing is ever purged or alerted**. |
| `MDM_IMPORT_SECRET` | Bearer secret for `POST /api/items/import`. Unset = the endpoint refuses every request. |

`.env*` is git-ignored except `.env.example`, which documents each of these
inline.

## Scripts

| Script            | Description                                  |
|-------------------|----------------------------------------------|
| `npm run dev`     | Dev server (Turbopack), after staging the wasm assets |
| `npm run build`   | `copy-wasm && prisma generate && next build`  |
| `npm start`       | Production server                             |
| `npm test`        | Vitest suite (needs the test DB up)           |
| `npm run test:ui` | The jsdom component tests only (`*.test.tsx`). jsdom has **no layout engine** — this is not evidence for a CSS or mobile change. |
| `npm run check:security-docs` | The `Security docs current` CI gate, run locally: fails when a watched security file changed without `docs/SECURITY.md`. |
| `npm run db:migrate` | `prisma migrate dev` (local)               |
| `npm run db:deploy`  | `prisma migrate deploy` (prod)             |
| `npm run db:seed`    | Seed the admin account                     |
| `npm run db:seed:e2e` | Seed the fixtures the Playwright suite expects |
| `npm run db:seed:analytics` | **Dev only.** Populate categories, UICs, readiness *signals* (service flags, on-hand marks, MDM last-logon) and demo closed receipts so the analytics dashboard renders locally. Overwrites those fields, so it **refuses any non-local `DATABASE_URL`** — a `NODE_ENV` check alone would not have stopped it, since `tsx` leaves that unset. The refusal is overridable with `ALLOW_NONLOCAL_DEMO_SEED=1`; that override exists for a deliberate staging run and should never be set in a shell that can reach production. |
| `npm run db:reset`   | Reset the local dev DB                     |
| `npm run lint`    | ESLint                                        |

## Project structure

```
src/
  app/                 # App Router routes
    actions/           # user-facing server actions (auth, transfers, account)
    admin/             # admin console + admin/actions server actions
                       #   analytics/ audit/ categories/ items/ queue/ units/ users/
    account/           # password change + saved signatures
    i/[itemId]/        # public read-only item page (+ QR PDF route)
    items/             # signed-in inventory list
    receipts/          # receipt builder, public receipt page, PDF + return flows
    unlock/            # public-access PIN gate
    privacy/  terms/   # public static pages (outside every gate)
    api/auth/          # Auth.js route handlers
    api/cron/purge/    # nightly purge + overdue-alert worker (CRON_SECRET)
    api/items/import/  # machine-driven MDM CSV import (MDM_IMPORT_SECRET)
  components/          # shared UI (server + client components)
    ui/                # shadcn/ui primitives (new UI only — see CLAUDE.md styling)
  lib/                 # prisma, authz, password, email, rate-limit, crypto, datetime
  modules/             # domain services
    items/  transfers/  receipts/  returns/  service-queue/
    audit/  users/  contacts/  signatures/  timers/  auth/
  types/               # shared type declarations
  auth.ts              # Auth.js config
  proxy.ts             # rate limit + PIN gate + coarse auth gate (Next 16 proxy, Node runtime)
prisma/                # schema, migrations, seed
scripts/               # copy-wasm, check-security-docs, gmail-token-rotation
tests/                 # test helpers (db reset/migrate, factories) + e2e specs
docs/                  # architecture, security inventory, design notes
```

## Auth & roles (summary)

Email + password. Accounts are **provisioned by an admin** (no public
self-registration); admins assign roles. Self-serve **password reset** is
available (`/forgot-password` → emailed single-use token). Sessions are
JWT (no DB session table). Authorization is enforced in `requireUser` /
`requireAdmin`, which re-read `role`/`isActive` from the DB each request, so
deactivations and role changes take effect immediately. See
[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the full model and **why we
use Auth.js rather than Supabase Auth**, and
[`docs/SECURITY.md`](./docs/SECURITY.md) for the complete inventory of security
controls (authn/authz, the public PIN gate, reset hardening, crypto seal, RLS
posture, CI gates) plus the known gaps and accepted risks.

## Testing

Vitest runs against a **real migrated Postgres** (`handreceipt_test`), truncating
between tests — services and custody invariants are covered with behavior, not
mocks. Component tests (`*.test.tsx`, `npm run test:ui`) opt into jsdom per file;
jsdom has no layout engine, so neither they nor `npm run build` are evidence for
a CSS or mobile change — verify visual work in a real browser. Playwright covers
browser/e2e (`tests/e2e`), seeded by `npm run db:seed:e2e`.

Only one agent or developer may run the suite at a time: it truncates a shared
`handreceipt_test` database, so two concurrent runs corrupt each other and the
failures look like unrelated flakes.

## Deployment

Hosted on **Vercel** (app) + **Supabase** (Postgres). Full steps — connection
strings, env vars, migrations, and the Vercel-Hobby commit-author-email
requirement — are in [`DEPLOY.md`](./DEPLOY.md).

`main` is branch-protected: merging needs a PR whose three required checks pass
(`Semgrep SAST`, `Build (next build)`, `Security docs current`), and Vercel
deploys production from `main` on merge. `next build` does **not** run
migrations, so apply any new migration to Supabase *before* the merge deploys.

## Known gaps / roadmap

- Public receipt/item pages are **enumerable by design** (a team requirement) — see the accepted-requirement note in `CLAUDE.md`.
- Signature images are stored inline in Postgres — moving them to object storage (to cut DB growth + client payload) is deferred until storage pressures the free-plan cap.
- Accountability: each technician is provisioned their **own** admin account (logins are not shared). Every return/audit records the acting account plus the picked signer's name, so individual accounts are what keep "who acted" unambiguous.
