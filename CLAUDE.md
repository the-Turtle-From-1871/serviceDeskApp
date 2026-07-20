@AGENTS.md
# Project Guide: Next.js 16 App

## Tech Stack
- Frontend: Next.js 16 (App Router, Server Components, React 19)
- Type Safety: TypeScript 5 & Turbopack
- Database: PostgreSQL (Supabase / Local Docker `postgres:16`) via Prisma 7
- Driver: `@prisma/adapter-pg` over `pg`
- Authentication: Auth.js v5 (Credentials, JWT sessions) + `bcryptjs`
- Validation & Utils: Zod, `pdf-lib`, `qrcode`
- Testing & Linting: Vitest (Integration), Playwright, ESLint 9

## Core Commands
- Dev Server: `npm run dev`
- Build App: `npm run build`
- Database Client: `npx prisma generate`
- Database Migration: `npx prisma migrate dev`
- Run Linters: `npm run lint`
- Run Integration Tests: `npx vitest run integration`
- Run E2E Tests: `npx playwright test`

## Documentation — Keep the Changelog Current (Non-Negotiable)
- Every **user-facing** change (any `feat:` or `fix:` that alters behavior, UI, data, or an endpoint) MUST add a `CHANGELOG.md` entry **before committing** — in the same commit as the code.
- Add entries under **today's date** (`## YYYY-MM-DD`, newest section at the top), grouped by **Added / Changed / Fixed / Removed / Security** per [Keep a Changelog](https://keepachangelog.com/). Describe the behavior change for a reader, not the diff.
- Skip only pure-internal commits with no user-facing effect: `docs:`, `test:`, `chore:`, and mechanical `refactor:` with no behavior change.
- Note any migration or ops step (new table, seed, cron, env var) under a **Notes** subsection, as existing entries do.

### 1. Authorization — Shared Technician Account (role-based, NOT ownership)
- Authorization is **role-based** (`ADMIN` / `USER`); inventory, receipts, and the queue are **shared org-wide**. Do NOT add `session.user.id` ownership filters to item/receipt/queue queries — gate on role.
- Every Server Action and Route Handler MUST start with `requireUser()` or `requireAdmin()` from `@/lib/authz` — never bare `auth()`. These re-read `role` + `isActive` from the DB per request, so demotion/deactivation take effect immediately.
- `requireAdmin()` for all privileged capabilities: returns, user management, named signatures, service-queue mutations, receipt timers, audits. A standard `USER` may read shared inventory, create receipts, and edit ONLY an item's current-holder email + current position (`userItemDetailsSchema`); `deviceName`/`homeUnit`/`notes` and the service/admin queues are admin-only. `updateItemDetailsAction` picks the schema by role, so the field restriction is enforced server-side, not just hidden in the UI.
- Never gate a capability on "the user happens to own no rows" — a demoted admin keeps their rows. Check the **ROLE**.
- Resolve identity, names, and signature blobs **server-side from the DB scoped to the acting user**; never trust client-posted names, ids, roles, or signatures.
- Public-by-design endpoints (login, home search, receipt + item lookup) are a reviewed exception and must stay read-only and PII-minimal — never widen them without explicit review.
- There is NO public self-registration — it was removed. Accounts are provisioned ONLY by an admin (`createUserAction` / `createUser`); do not re-add a public `/register` flow without an explicit decision. (`registerSchema` is retained unused for a possible future re-implementation.)
- Route handlers with no session (cron) authenticate via a constant-time `CRON_SECRET` compare and fail closed.

> **ACCEPTED REQUIREMENT — public, enumerable receipts AND items.** Logged-out recipients MUST be able to **search, view, and download** hand receipts by `receiptNumber`/serial, AND to **search the inventory and open any item page** (`/i/<id>`, home serial search). The team has explicitly accepted the resulting tradeoff: receipts are enumerable (sequential `HR-000001…` numbers) and the public receipt page + PDF route expose party PII and signature images with no auth; item pages/search expose the full device catalog (serials, home unit, current holder, receipt history) with no auth. This is **intended — do NOT "fix" it**: do not gate `/receipts/*`, `/receipts/*/pdf`, `/i/*`, or the public search behind auth, and do not make receipt identifiers unguessable, when re-auditing. It CAN be hardened later **if the team asks** (e.g. unguessable receipt tokens, auth-gating routes, or hiding signatures/holder from the public web pages) — treat that as a deliberate feature change requiring an explicit request, not a security bug to auto-remediate.

### 2. Injection Flaws (SQLi & XSS)
- Use standard Prisma methods (`prisma.user.findMany`) for automatic query parameterization.
- NEVER use string concatenation or template interpolation inside manual raw queries.
- Do not use React's `dangerouslySetInnerHTML` unless explicitly approved.

### 3. Supply Chain Protection
- Validate that any proposed npm library actually exists and is healthy by running `npm view <package-name>` before installing. Do not install hallucinated packages.

### 4. Auth, Secrets & Data Leakage
- Enforce strict input validation via Zod schemas before hashing strings with `bcryptjs`.
- Never hardcode credentials. Use `process.env.DATABASE_URL` or configuration variables.
- Mark sensitive utility files with `import 'server-only'` to block accidental client-side bundling.

### 5. Error Handling
- Catch exceptions gracefully in Server Actions. Return generic messages to the client (e.g., `"Something went wrong"`) and log detailed stack traces strictly on the server.

### 6. Supabase Row Level Security (RLS)
- RLS is **NOT** the authorization boundary. The app reaches Postgres **only through Prisma** on a privileged role that **bypasses RLS** — all authz lives in the app layer (see #1). Never assume the DB scopes rows for you.
- Every table is `RLS enabled, no policy` = deny-all for the `anon`/`authenticated` PostgREST roles. The Supabase Data API / anon key must stay **unused**. Do not add a Supabase JS client or the anon key to the app.
- New tables inherit RLS-enabled via the `rls_auto_enable` event trigger. **Never disable RLS on a table** (that exposes it to the public anon key) and **never add a permissive policy** without explicit review.
- Never `GRANT EXECUTE` on a `public` function to `anon`/`authenticated`.


## Data Fetching & N+1 Prevention (Non-Negotiable)
- **Never query inside a loop/`.map`.** No `Promise.all(ids.map(id => prisma...))`. Batch with `findMany({ where: { id: { in: ids } } })`, fetch relations with `include`/`select`, and aggregate per-key with `groupBy` (see `getLatestAuditMap`).
- **Bound every list.** Server Components/queries that back a list MUST paginate (`take` + keyset/cursor) — never `findMany` an unbounded table (Items is 1,200+ and growing). Do not ship the whole table to a Client Component. The `/items` list is the reference: `listItems` is server-side **paginated + sorted** (URL-driven `?page/sort/dir`), and `ItemSelectTable` holds only the current page. `auditState` is derived (not an `Item` column), so it is **display-only — never a server `ORDER BY`**.
- **`select` only the columns the view renders.** Never pull signature blobs or PII into list/search/type-ahead queries.
- **Index every hot `where`/`orderBy` column.** `contains` + `mode:"insensitive"` compiles to `ILIKE '%q%'` and needs a **pg_trgm GIN** index (a B-tree won't help); prefer `startsWith` (B-tree) when UX allows, and debounce server-side type-aheads.
- **Memoize deterministic work.** QR data URLs are cached across requests (and deploys) via `unstable_cache` in `qr.ts`, keyed on the resolved URL — they are immutable, so never re-encode per request. Use React `cache()` only for per-request dedupe.
- **`Item.serialNumber` is `@unique @db.Citext`** — case-insensitive identity, like `User.email`. Don't assume case-sensitive serial distinctness. The CSV import dedups case-insensitively and leans on the DB constraint (`createMany({ skipDuplicates: true })`) as the race-safe backstop.

## Backend Architecture & Feature Constraints


### 🤖 Service & Ticket Lifecycles
* **Immutable Closed State:** Once a ticket status transitions to "Closed", it becomes entirely immutable (cannot be reopened, edited, or modified).
* **90-Day Purge:** Tickets must automatically calculate an expiration timestamp exactly 90 days after closing. A background worker must permanently delete these records upon expiration.
* **DCSIM Notifications:** Entities are identified as "DCSIM" via a checkbox/boolean field. The "Notify for pickup" UI button must be completely hidden if the recipient isn't DCSIM, paired with backend validation to reject non-DCSIM notification events.


### 🤖 Service Queue (item-level)
* **Needs-service flag:** Items are placed in the service queue by a per-item "Needs service?" flag captured on the hand-receipt builder (per serial) or on the item detail page. Each flagged item carries a service type: **Reimage**, **Repair**, or **Other** (with a custom message stored in `serviceNote`).
* **Item-level queue:** The queue holds one entry per item (`ServiceQueueItem`, unique `itemId`), and only items whose entry is `PENDING` appear. Each entry may be tied to the hand receipt it was flagged on (`transferId`), shown on the item detail page.
* **Mark Completed (reversible):** Removing an item from the queue sets its status to `COMPLETED` — the record is retained (never deleted) and drops off the active queue. It can be reopened to `PENDING` from the item detail page.
* **Queue view:** The `/admin/queue` view lists SN, Device Name, Unit (item home unit), Service Type, and Actions (View + Mark Completed), with search, service-type filter, sort, and user-toggleable columns.
