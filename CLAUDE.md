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

## Security Guardrails (Non-Negotiable)

### 1. Broken Access Control & IDOR
- Every Server Action and Route Handler MUST check authentication first:
  `const session = await auth(); if (!session) throw new Error("Unauthorized");`
- Never trust input IDs blindly. Always filter Prisma queries using the verified backend `session.user.id` to ensure ownership.

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
