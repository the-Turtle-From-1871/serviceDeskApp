@AGENTS.md
# Project Guide: Next.js 16 App

## Tech Stack
- Frontend: Next.js 16 (App Router, Server Components, React 19)
- Type Safety: TypeScript 5 & Turbopack
- Database: PostgreSQL (Supabase / Local Docker `postgres:16`) via Prisma 7
- Driver: `@prisma/adapter-pg` over `pg`
- Authentication: Auth.js v5 (Credentials, JWT sessions) + `bcryptjs`
- Validation & Utils: Zod, `pdf-lib`, `qrcode`
- Styling: **two systems, on purpose** — see the styling rule below
- Charts: `recharts`; icons: `lucide-react`; PNG export: `html-to-image`
- Testing & Linting: Vitest (Integration), Playwright, ESLint 9

## Styling — Two Systems Coexist (read before touching CSS)
- **`globals.css` is the original design system** (the "property book" ledger look) and backs every pre-existing page via classes like `.card` / `.stack` / `.btn` / `.table`. It is NOT being migrated wholesale.
- **Tailwind v4 + `shadcn/ui` are for NEW UI only** (`src/components/ui/*`, the analytics dashboard). New work should prefer them; do not rewrite existing pages to Tailwind as a drive-by.
- `src/app/styles.css` is the entry point and makes the coexistence safe. Two rules keep it that way — **do not "simplify" either one**:
  - **Preflight is deliberately NOT imported.** Only Tailwind's `theme` + `utilities` layers are. Importing `tailwindcss` wholesale pulls in preflight and would restyle every existing page.
  - **`globals.css` is imported into a `legacy` cascade layer declared before Tailwind's layers**, so a utility beats a legacy rule of equal specificity. Unlayered CSS outranks *all* layered CSS, so without this every Tailwind utility would silently lose to `globals.css`.
- Because preflight is absent, `shadcn` primitives must set what preflight normally supplies: `appearance-none` + an explicit background/font on `<button>`-rooted parts, **`border-solid` wherever a `border-*` width is set** (Tailwind's border utilities set width only), and `[&_svg]:block` on icons.
- shadcn tokens are mapped onto the ledger palette in `styles.css` via `var()` references, so retuning `globals.css` retunes the dashboard. shadcn's `--primary` is aliased to `--primary-token` because `globals.css` already defines `--primary` (a self-reference would resolve to nothing).
- **Touch targets:** shadcn's stock sizes (32/36px) are below this app's documented 44px floor (`--tap`). The primitives carry `pointer-coarse:` + `max-md:` height overrides to restore it; if you add a component or override a height (e.g. `h-auto`), restore the floor explicitly or it ships as a ~22px tap target on a phone.
- **`npm run build` and jsdom are NOT evidence for a CSS change.** Neither has a layout engine. Verify visual work in a real browser.

## Core Commands
- Dev Server: `npm run dev`
- Build App: `npm run build`
- Database Client: `npx prisma generate`
- Database Migration: `npx prisma migrate dev`
- Run Linters: `npm run lint`
- Run Integration Tests: `npx vitest run integration`
- Run E2E Tests: `npx playwright test`

## CI/CD & Branch Protection (`main` is protected)
- **`main` is branch-protected.** Merging requires a PR whose required checks pass: **`Semgrep SAST`** and **`Build (next build)`** (both defined in `.github/workflows/ci.yml`, run on push + PR to `main`). `strict` is on (the branch must be up to date with `main`). Admins may bypass in an emergency (`enforce_admins: false`), but the default path is **branch → PR → green checks → merge**; Vercel deploys prod from `main` after merge.
- **Do feature work on a branch, not direct pushes to `main`.** Honor **migrate-before-push**: apply any new prod migration to Supabase *before* the merge deploys — a bare `next build` never runs `migrate deploy`, so deployed code that `SELECT`s a not-yet-created column will break. See `docs/ARCHITECTURE.md` (Hosting topology) and `DEPLOY.md`.
- **A third job, `Security docs current`, runs on PRs only** (`scripts/check-security-docs.mjs`): it fails when a watched security file changes without `docs/SECURITY.md` changing. It is PR-only because it diffs against the merge base, which is meaningless for a push to `main`. ⚠️ **Not yet in the required-checks list** — until it is added there it reports but does not block.
- **Semgrep runs from the official docker image** (`semgrep/semgrep`) via `docker run`, NOT a host `pipx` install — a pipx install crashes on the runner's Python 3.12 with `ModuleNotFoundError: pkg_resources` (setuptools ≥81 removed it). Don't "simplify" it back to pipx.
- **Pushing workflow files (`.github/workflows/*`) needs the `workflow` gh token scope** — a plain `repo`-scoped token is rejected. Grant with `gh auth refresh -s workflow`.
- **An `xhigh` review marker is required before pushing.** Run `/code-review xhigh` on the branch, then record `git rev-parse HEAD > .git/xhigh-review-ok` (per-commit — a new commit needs a fresh review). ⚠️ This is a **Claude Code `PreToolUse` hook** (`.claude/settings.json` → `.claude/hooks/xhigh-review-gate.sh`), **not a git hook** — it gates agent tool calls only. A human pushing from their own terminal is unaffected, and there are no git hooks installed in `.git/hooks`. Its `if: "Bash(git push*)"` matcher also over-fires on unrelated commands that merely contain a `git` subcommand.

## Documentation — Keep Docs Current as You Change Code (Non-Negotiable)
- **Docs are part of the change, not a follow-up.** Any commit that alters behavior, UI, data, an endpoint, a command, an env var, or an architectural rule MUST update the affected documentation **in the same commit as the code** — never "later", never a separate PR. A change that ships without its doc update is incomplete.
- **Keep this file (and `AGENTS.md`/`README.md`) truthful.** When a change contradicts, extends, or retires something written here — a security rule, a data-fetching constraint, a feature-constraint section, a listed command — edit the relevant section in the same commit so the guide never describes code that no longer exists. Do not leave stale instructions for the next reader.
- **CHANGELOG.md — every user-facing change.** Any `feat:` or `fix:` that alters behavior, UI, data, or an endpoint MUST add a `CHANGELOG.md` entry before committing, under **today's date** (`## YYYY-MM-DD`, newest section at the top), grouped by **Added / Changed / Fixed / Removed / Security** per [Keep a Changelog](https://keepachangelog.com/). Describe the behavior change for a reader, not the diff.
- **Note ops/migration steps.** Any new table, seed, cron, or env var goes under a **Notes** subsection of the changelog entry, as existing entries do — plus its own config/README location if one exists.
- **What to skip.** Only pure-internal commits with no user-facing effect and no rule change: `docs:`, `test:`, `chore:`, and mechanical `refactor:` that alters no behavior. When unsure whether a change is user-facing, document it.
- **`docs/SECURITY.md` — the living inventory of security controls.** Any change to an authn/authz check, to crypto/tokens/cookies/secrets, to the public (unauthenticated) surface, to retention windows, or to the CI security posture MUST update the matching entry there **in the same commit**, and bump its *Last reviewed* date. It also carries the **Known gaps & accepted risks** list — add to it rather than leaving a gap undocumented, and delete a control's entry when the control is removed.
  - **This one is enforced, not just requested.** The `Security docs current` CI job (`scripts/check-security-docs.mjs`) fails a PR that touches a watched security file without touching `docs/SECURITY.md`. Run it locally with `npm run check:security-docs`. The watch list lives at the top of that script — **when you add a new security-relevant file, add it there too**, or it silently escapes the guardrail. Genuine no-op changes (rename, comment, mechanical refactor) bypass with `[skip security-doc]` in a commit message, which is deliberately visible in review rather than silent.

### 1. Authorization — Shared Technician Account (role-based, NOT ownership)
- Authorization is **role-based** (`ADMIN` / `USER`); inventory, receipts, and the queue are **shared org-wide**. Do NOT add `session.user.id` ownership filters to item/receipt/queue queries — gate on role.
- Every Server Action and Route Handler MUST start with `requireUser()` or `requireAdmin()` from `@/lib/authz` — never bare `auth()`. These re-read `role` + `isActive` from the DB per request, so demotion/deactivation take effect immediately.
- `requireAdmin()` for all privileged capabilities: returns, user management, named signatures, service-queue mutations, receipt timers, audits. A standard `USER` may read shared inventory, create receipts, and edit ONLY an item's current-holder email + current position (`userItemDetailsSchema`); `deviceName`/`homeUnit`/`notes` and the service/admin queues are admin-only. `updateItemDetailsAction` picks the schema by role, so the field restriction is enforced server-side, not just hidden in the UI.
- Never gate a capability on "the user happens to own no rows" — a demoted admin keeps their rows. Check the **ROLE**.
- Resolve identity, names, and signature blobs **server-side from the DB scoped to the acting user**; never trust client-posted names, ids, roles, or signatures.
- Public-by-design endpoints (login, home search, receipt + item lookup) are a reviewed exception and must stay read-only and PII-minimal — never widen them without explicit review.
- There is NO public self-registration — it was removed. Accounts are provisioned ONLY by an admin (`createUserAction` / `createUser`); do not re-add a public `/register` flow without an explicit decision. (`registerSchema` is retained unused for a possible future re-implementation.)
- Route handlers with no session (cron) authenticate via a constant-time `CRON_SECRET` compare and fail closed.
- **Provision an individual admin account per technician — do NOT share one login.** Returns/audits record the acting account id (+ the picked signer's name), so accountability for "who processed this" depends on each person having their own account.

> **ACCEPTED REQUIREMENT — public, enumerable receipts AND items.** Logged-out recipients MUST be able to **search, view, and download** hand receipts by `receiptNumber`/serial, AND to **search the inventory and open any item page** (`/i/<id>`, home serial search). The team has explicitly accepted the resulting tradeoff: receipts are enumerable (sequential `HR-000001…` numbers) and the public receipt page + PDF route expose party PII and signature images with no auth; item pages/search expose the full device catalog (serials, home unit, current holder, receipt history) with no auth. This is **intended — do NOT "fix" it**: do not gate `/receipts/*`, `/receipts/*/pdf`, `/i/*`, or the public search behind auth, and do not make receipt identifiers unguessable, when re-auditing. It CAN be hardened later **if the team asks** (e.g. unguessable receipt tokens, auth-gating routes, or hiding signatures/holder from the public web pages) — treat that as a deliberate feature change requiring an explicit request, not a security bug to auto-remediate.
>
> **UPDATE (2026-07-22): the public surface is now behind an 8-digit PIN gate for logged-out users** (`src/proxy.ts`, controlled by `PUBLIC_ACCESS_PIN_ENABLED`). This does NOT change the enumerability tradeoff above — it adds a shared-PIN wall in front of `/`, `/i/*`, and `/receipts/*`. The gate is merged into the existing `src/proxy.ts` (which already coarse-login-gates `/items`, `/admin/*`, etc.); the PIN branch is a **non-authz gate** (it checks the PIN cookie / a logged-in session). Real authz still lives per-route (`requireUser`/`requireAdmin`) and re-reads role/isActive from the DB — the proxy never becomes the authz boundary. Logged-in users bypass the PIN; the PIN is admin-settable from `/admin`.

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
- **Never query inside a loop/`.map`.** No `Promise.all(ids.map(id => prisma...))`. Batch with `findMany({ where: { id: { in: ids } } })`, fetch relations with `include`/`select`, and aggregate per-key with `groupBy` (one grouped query, not one per id).
- **Bound every list.** Server Components/queries that back a list MUST paginate (`take` + keyset/cursor) — never `findMany` an unbounded table (Items is 1,200+ and growing). Do not ship the whole table to a Client Component. The `/items` list is the reference: `listItems` is server-side **paginated + sorted** (URL-driven `?page/sort/dir`), and `ItemSelectTable` holds only the current page. `auditState` is derived (time-dependent, not stored), so **never `ORDER BY` the derived value itself** — the audit-status sort rides the denormalized **`Item.lastAuditedAt`** column (maintained by `recordAudit` in a txn, backfilled by migration, indexed). `listItems` maps `sort=auditState` → `ORDER BY "lastAuditedAt"` (nulls last, both dirs), and the badge reads the same column, so sort and display share one source of truth.
- **`select` only the columns the view renders.** Never pull signature blobs or PII into list/search/type-ahead queries.
- **Index every hot `where`/`orderBy` column.** `contains` + `mode:"insensitive"` compiles to `ILIKE '%q%'` and needs a **pg_trgm GIN** index (a B-tree won't help); the public serial + receipt searches have these. Debounce server-side type-aheads. **GOTCHA:** a **citext** column (`Item.serialNumber`) uses citext's own ILIKE operator, which the text `gin_trgm_ops` index does NOT serve — that search must cast `"serialNumber"::text ILIKE …` (parameterized `$queryRaw`, see `searchItemsBySerial`) to actually use the index.
- **Memoize deterministic work.** QR data URLs are cached across requests (and deploys) via `unstable_cache` in `qr.ts`, keyed on the resolved URL — they are immutable, so never re-encode per request. Use React `cache()` only for per-request dedupe.
- **`Item.serialNumber` is `@unique @db.Citext`** — case-insensitive identity, like `User.email`. Don't assume case-sensitive serial distinctness. The CSV import matches on serial case-insensitively: a **new** serial is created (leaning on the DB constraint `createMany({ skipDuplicates: true })` as the race-safe backstop), while a serial that **already exists** is **updated in place** (changed `deviceName`/`deviceUIC`/assigned-user logged to `ItemEdit`; MDM telemetry updated silently), not skipped as a duplicate. `make`/`model` are never overwritten on a match. New rows require `make`+`model`+`serialNumber`; matched rows require only `serialNumber`.

## Backend Architecture & Feature Constraints


### 🤖 Service & Ticket Lifecycles
* **Immutable Closed State:** Once a ticket status transitions to "Closed", it becomes entirely immutable (cannot be reopened, edited, or modified).
* **90-Day Purge:** Tickets must automatically calculate an expiration timestamp exactly 90 days after closing. A background worker must permanently delete these records upon expiration.
* **DCSIM Notifications:** Entities are identified as "DCSIM" via a checkbox/boolean field. The "Notify for pickup" UI button must be completely hidden if the recipient isn't DCSIM, paired with backend validation to reject non-DCSIM notification events.


### 🤖 Operational Readiness & Analytics
* **Two independent readiness fields.** `Item.isAccountedFor` (bool, default true) answers "do we physically have it"; `Item.deployableStatus` (nullable enum `DEPLOYED` / `READY_TO_DEPLOY` / `IN_REPAIR` / `RETIRED`) answers "can it go out". `deployableStatus` is **nullable with no default on purpose** — an untriaged item genuinely has no readiness state, and an open hand receipt does NOT imply `DEPLOYED` (a device may be turned in for service). Never backfill it from receipt state. UI surfaces null as **"Untriaged"** rather than hiding it, so chart totals always match the fleet size.
* **`ItemStatusHistory` is a SNAPSHOT table, not deltas.** Each row is the item's state *after* a change, so composition at time T is "newest row per item at or before T" — one indexed `DISTINCT ON`, no delta replay. Every write path must record history **in the same transaction** as the `Item` update, and must write **only for items that actually changed** (re-applying an identical status writes nothing, so the chart never grows a step where nothing happened). Forward-only: the migration seeds one baseline row per item and invents no history before it.
* **Categories are a MANAGED LIST with a DENORMALIZED value — deliberately not a foreign key.** `DeviceCategory` (citext-unique `name`) is the curated vocabulary admins maintain at `/admin/categories`; `Item.deviceCategory` stays a plain indexed **string**. The reason: a CSV import must be able to carry a category the property book has not registered yet, so an unknown category must never make an import fail. Keeping the two coherent is `categories.service.ts`'s job, and it does it two ways — **deletion is refused while any item still carries the name** (otherwise those devices hold a value that appears in no picker), and **imports register unseen names** (`learnCategories`, mirroring `learnUnits`). Do not "normalise" this into an FK without re-solving both. Changes to an item's category are logged to `ItemEdit` like `deviceUIC`.
* **Readiness edits are ADMIN-only** and live in their own Server Action (`bulkUpdateReadinessAction`), deliberately NOT folded into `updateItemDetailsAction`'s role-picked schema — that keeps the USER-editable field set exactly as narrow as it was (holder email + position only).
* **Analytics is admin-only and re-queries on the server.** All dashboard state lives in the URL (`?uic=&range=`), so there is exactly one filtering implementation and it is the SQL one. The whole page is a fixed number of queries and does not grow with fleet size. The unit leaderboard is intentionally NOT scoped by the global UIC filter — it is how a user picks a unit.
* **Velocity counts ITEMS, not receipts.** A receipt can carry mixed categories, so counting receipts per category would double-count and the stack would not sum to the total. Also note closed receipts are purged after 90 days, so that series cannot see further back than the purge window — say so in the UI rather than hiding it.
* **Chart colours are validated, not taste.** See `src/app/admin/analytics/palette.ts`: re-run the validator against the ledger surface (`#fbfcf9`) before changing a hex. The accountability donut is blue-vs-red because green-vs-red fails colourblind separation — **do not "fix" it back to green.** The per-chart **table view** is the documented mitigation for three under-contrast palette slots; do not remove it.

### 🤖 Service Queue (item-level)
* **Needs-service flag:** Items are placed in the service queue by a per-item "Needs service?" flag captured on the hand-receipt builder (per serial) or on the item detail page. Each flagged item carries a service type: **Reimage**, **Repair**, or **Other** (with a custom message stored in `serviceNote`).
  * **DCSIM-recipient only (builder):** on the hand-receipt builder the "Needs service?" control (the whole Service column) is offered **only when the recipient is DCSIM** — the queue is for kit coming in to the desk, not equipment issued to an outside customer. Same "completely hidden in UI **and** enforced server-side" pattern as the pickup button: `createReceiptAction` drops any `service[...]` selections when `receiver.isDcsim` is false, so a crafted POST can't enqueue. The **item-detail-page** flag is unaffected (no recipient there).
* **Item-level queue:** The queue holds one entry per item (`ServiceQueueItem`, unique `itemId`), and only items whose entry is `PENDING` appear. Each entry may be tied to the hand receipt it was flagged on (`transferId`), shown on the item detail page.
* **Mark Completed (reversible):** Removing an item from the queue sets its status to `COMPLETED` — the record is retained (never deleted) and drops off the active queue. It can be reopened to `PENDING` from the item detail page.
* **Queue view:** The `/admin/queue` view lists SN, Device Name, Unit (item home unit), Service Type, and Actions (View + Mark Completed), with search, service-type filter, sort, and user-toggleable columns.
