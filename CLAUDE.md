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