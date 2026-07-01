# Hand Receipt App — Plan 1: Foundation & Auth

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Next.js + Prisma + Postgres project with email/password authentication, roles (ADMIN/USER), a seeded first admin, and server-side role guards.

**Architecture:** Next.js App Router (TypeScript) single codebase. Prisma ORM over PostgreSQL. Auth.js v5 (`next-auth@beta`) Credentials provider with **JWT session strategy** (required for Credentials — the DB adapter is NOT used for sessions). Passwords hashed with bcrypt. Domain logic lives in `src/modules/*` service files; auth wiring in `src/auth.ts` + `src/lib/*`. Vitest for unit/integration, Playwright for E2E.

**Tech Stack:** Next.js (App Router), TypeScript, Prisma, PostgreSQL, next-auth@beta (Auth.js v5), bcryptjs, zod, Vitest, Playwright.

## Global Constraints

- Node 20+.
- All mutating actions and scoped reads are authorized **server-side** — never trust the client role.
- Credentials provider ⇒ `session: { strategy: "jwt" }`. Add `id` and `role` to the token in the `jwt` callback and copy them to `session.user` in the `session` callback.
- Passwords stored only as bcrypt hashes (cost 12). Never log or return `passwordHash`.
- Enums: `Role = { ADMIN, USER }`. Use Prisma enums, not strings.
- No open self-registration. Admins create accounts. First admin is seeded.
- Env vars: `DATABASE_URL`, `AUTH_SECRET`, `APP_URL`. Never hardcode secrets.

---

### Task 1: Project scaffold + tooling

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `.gitignore`, `.env.example`, `vitest.config.ts`
- Create: `src/app/layout.tsx`, `src/app/page.tsx`

**Interfaces:**
- Produces: a runnable Next.js app (`npm run dev`), `npm run test` (Vitest) wired.

- [ ] **Step 1: Scaffold Next.js app**

Run in `c:\inventoryApp`:
```bash
npx create-next-app@latest . --typescript --app --src-dir --eslint --no-tailwind --import-alias "@/*" --use-npm --yes
```
(If the directory is non-empty due to `docs/`, accept the prompt to proceed; keep existing files.)

- [ ] **Step 2: Install dependencies**

```bash
npm install next-auth@beta @prisma/client bcryptjs zod qrcode
npm install -D prisma vitest @vitejs/plugin-react vite-tsconfig-paths @types/bcryptjs @types/qrcode @playwright/test tsx
```

- [ ] **Step 3: Add test + db scripts to package.json**

In `package.json` `"scripts"`, add:
```json
"test": "vitest run",
"test:watch": "vitest",
"db:migrate": "prisma migrate dev",
"db:seed": "tsx prisma/seed.ts",
"db:reset": "prisma migrate reset --force"
```

- [ ] **Step 4: Create vitest.config.ts**

```typescript
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    fileParallelism: false, // integration tests share one test DB
  },
});
```

- [ ] **Step 5: Create .env.example**

```
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/handreceipt?schema=public"
AUTH_SECRET="generate-with: npx auth secret"
APP_URL="http://localhost:3000"
```

- [ ] **Step 6: Add a trivial passing test to prove the runner works**

Create `src/lib/smoke.test.ts`:
```typescript
import { expect, test } from "vitest";
test("vitest runs", () => {
  expect(1 + 1).toBe(2);
});
```

- [ ] **Step 7: Run the test**

Run: `npm run test`
Expected: PASS (1 test).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: scaffold Next.js app with Prisma/auth/test tooling"
```

---

### Task 2: Prisma schema (User) + client singleton + local Postgres

**Files:**
- Create: `prisma/schema.prisma`
- Create: `src/lib/prisma.ts`
- Create: `docker-compose.yml` (local Postgres for dev/test)

**Interfaces:**
- Produces: `prisma` client (default export `@/lib/prisma`); `User` model with `id, name, email, passwordHash, role, isActive, createdAt, updatedAt`; `Role` enum.

- [ ] **Step 1: Add local Postgres via docker-compose.yml**

```yaml
services:
  db:
    image: postgres:16
    ports: ["5432:5432"]
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: handreceipt
    volumes: ["pgdata:/var/lib/postgresql/data"]
volumes:
  pgdata:
```
Run: `docker compose up -d`
Expected: a `db` container listening on 5432. Copy `.env.example` to `.env` and to `.env.test` (change db name to `handreceipt_test` in `.env.test`).

- [ ] **Step 2: Create prisma/schema.prisma**

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum Role {
  ADMIN
  USER
}

model User {
  id           String   @id @default(cuid())
  name         String
  email        String   @unique
  passwordHash String
  role         Role     @default(USER)
  isActive     Boolean  @default(true)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
}
```

- [ ] **Step 3: Create the first migration**

Run: `npm run db:migrate -- --name init_user`
Expected: migration created and applied; `User` table exists.

- [ ] **Step 4: Create src/lib/prisma.ts (singleton)**

```typescript
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export default prisma;
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add Prisma User model, client singleton, local Postgres"
```

---

### Task 3: Password hashing utility (TDD)

**Files:**
- Create: `src/lib/password.ts`
- Test: `src/lib/password.test.ts`

**Interfaces:**
- Produces: `hashPassword(plain: string): Promise<string>`, `verifyPassword(plain: string, hash: string): Promise<boolean>`.

- [ ] **Step 1: Write the failing test**

`src/lib/password.test.ts`:
```typescript
import { expect, test } from "vitest";
import { hashPassword, verifyPassword } from "./password";

test("hash then verify succeeds for correct password", async () => {
  const hash = await hashPassword("s3cret!");
  expect(hash).not.toBe("s3cret!");
  expect(await verifyPassword("s3cret!", hash)).toBe(true);
});

test("verify fails for wrong password", async () => {
  const hash = await hashPassword("s3cret!");
  expect(await verifyPassword("nope", hash)).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- password`
Expected: FAIL (module not found / functions undefined).

- [ ] **Step 3: Write minimal implementation**

`src/lib/password.ts`:
```typescript
import bcrypt from "bcryptjs";

const COST = 12;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, COST);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- password`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add bcrypt password hashing utility"
```

---

### Task 4: Auth.js config with Credentials provider + JWT role/id

**Files:**
- Create: `src/auth.ts`
- Create: `src/app/api/auth/[...nextauth]/route.ts`
- Create: `src/types/next-auth.d.ts`
- Create: `middleware.ts` (project root)

**Interfaces:**
- Consumes: `verifyPassword` (Task 3), `prisma` (Task 2).
- Produces: exports `{ handlers, auth, signIn, signOut }` from `@/auth`. Session shape: `session.user = { id: string, role: "ADMIN"|"USER", name, email }`.

- [ ] **Step 1: Augment next-auth types**

`src/types/next-auth.d.ts`:
```typescript
import type { Role } from "@prisma/client";
import "next-auth";
import "next-auth/jwt";

declare module "next-auth" {
  interface Session {
    user: { id: string; role: Role; name: string; email: string };
  }
  interface User {
    id: string;
    role: Role;
  }
}
declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    role: Role;
  }
}
```

- [ ] **Step 2: Create src/auth.ts**

```typescript
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { verifyPassword } from "@/lib/password";

const credsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      authorize: async (raw) => {
        const parsed = credsSchema.safeParse(raw);
        if (!parsed.success) return null;
        const { email, password } = parsed.data;
        const user = await prisma.user.findUnique({ where: { email } });
        if (!user || !user.isActive) return null;
        if (!(await verifyPassword(password, user.passwordHash))) return null;
        return { id: user.id, name: user.name, email: user.email, role: user.role };
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = user.role;
      }
      return token;
    },
    session({ session, token }) {
      session.user.id = token.id;
      session.user.role = token.role;
      return session;
    },
  },
});
```

- [ ] **Step 3: Create the route handler**

`src/app/api/auth/[...nextauth]/route.ts`:
```typescript
import { handlers } from "@/auth";
export const { GET, POST } = handlers;
```

- [ ] **Step 4: Create middleware to protect app routes**

`middleware.ts` (root):
```typescript
export { auth as middleware } from "@/auth";

export const config = {
  // Protect everything except auth API, login, public item pages, static assets.
  matcher: ["/((?!api/auth|login|i/|_next/static|_next/image|favicon.ico).*)"],
};
```

- [ ] **Step 5: Generate AUTH_SECRET and verify build**

Run: `npx auth secret` (writes `AUTH_SECRET` to `.env`), then `npm run build`
Expected: build succeeds with no type errors.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: Auth.js credentials provider with JWT id/role"
```

---

### Task 5: Authorization helpers (TDD)

**Files:**
- Create: `src/lib/authz.ts`
- Test: `src/lib/authz.test.ts`

**Interfaces:**
- Consumes: `auth` (Task 4) session shape.
- Produces:
  - `requireUser(): Promise<SessionUser>` — throws `AuthError("UNAUTHENTICATED")` if no session.
  - `requireAdmin(): Promise<SessionUser>` — throws `AuthError("FORBIDDEN")` if not ADMIN.
  - `class AuthError extends Error { code: "UNAUTHENTICATED" | "FORBIDDEN" }`
  - `type SessionUser = { id: string; role: Role; name: string; email: string }`

The `auth()` call is injected via a parameter default so it can be mocked in unit tests.

- [ ] **Step 1: Write the failing test**

`src/lib/authz.test.ts`:
```typescript
import { expect, test } from "vitest";
import { requireUser, requireAdmin, AuthError } from "./authz";

const admin = { id: "1", role: "ADMIN", name: "A", email: "a@x.co" } as const;
const user = { id: "2", role: "USER", name: "U", email: "u@x.co" } as const;

test("requireUser returns the user when a session exists", async () => {
  const getSession = async () => ({ user: user });
  await expect(requireUser(getSession)).resolves.toEqual(user);
});

test("requireUser throws UNAUTHENTICATED when no session", async () => {
  const getSession = async () => null;
  await expect(requireUser(getSession)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
});

test("requireAdmin throws FORBIDDEN for a standard user", async () => {
  const getSession = async () => ({ user: user });
  await expect(requireAdmin(getSession)).rejects.toMatchObject({ code: "FORBIDDEN" });
});

test("requireAdmin returns the user for an admin", async () => {
  const getSession = async () => ({ user: admin });
  await expect(requireAdmin(getSession)).resolves.toEqual(admin);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- authz`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

`src/lib/authz.ts`:
```typescript
import type { Role } from "@prisma/client";
import { auth } from "@/auth";

export type SessionUser = { id: string; role: Role; name: string; email: string };

export class AuthError extends Error {
  constructor(public code: "UNAUTHENTICATED" | "FORBIDDEN") {
    super(code);
    this.name = "AuthError";
  }
}

type GetSession = () => Promise<{ user: SessionUser } | null>;

export async function requireUser(getSession: GetSession = auth): Promise<SessionUser> {
  const session = await getSession();
  if (!session?.user) throw new AuthError("UNAUTHENTICATED");
  return session.user;
}

export async function requireAdmin(getSession: GetSession = auth): Promise<SessionUser> {
  const user = await requireUser(getSession);
  if (user.role !== "ADMIN") throw new AuthError("FORBIDDEN");
  return user;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- authz`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add requireUser/requireAdmin authorization helpers"
```

---

### Task 6: Seed the first admin

**Files:**
- Create: `prisma/seed.ts`

**Interfaces:**
- Consumes: `hashPassword` (Task 3), `prisma` (Task 2).
- Produces: an idempotent seed creating one ADMIN from `SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD` env (defaults `admin@example.com` / `ChangeMe123!`).

- [ ] **Step 1: Write prisma/seed.ts**

```typescript
import prisma from "../src/lib/prisma";
import { hashPassword } from "../src/lib/password";

async function main() {
  const email = process.env.SEED_ADMIN_EMAIL ?? "admin@example.com";
  const password = process.env.SEED_ADMIN_PASSWORD ?? "ChangeMe123!";
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log(`Admin ${email} already exists — skipping.`);
    return;
  }
  await prisma.user.create({
    data: {
      name: "Administrator",
      email,
      passwordHash: await hashPassword(password),
      role: "ADMIN",
    },
  });
  console.log(`Seeded admin ${email}. CHANGE THIS PASSWORD after first login.`);
}

main().finally(() => prisma.$disconnect());
```

- [ ] **Step 2: Run the seed**

Run: `npm run db:seed`
Expected: "Seeded admin admin@example.com". Re-run → "already exists — skipping" (idempotent).

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: seed initial admin account"
```

---

### Task 7: Login page + sign-out

**Files:**
- Create: `src/app/login/page.tsx`
- Create: `src/app/actions/auth.ts`
- Create: `src/components/SignOutButton.tsx`
- Modify: `src/app/page.tsx` (home redirects based on session)

**Interfaces:**
- Consumes: `signIn`, `signOut`, `auth` (Task 4).
- Produces: a working login form; unauthenticated users are redirected to `/login` by middleware; `/` redirects authenticated users to `/dashboard` (created in Plan 3; for now to `/admin` placeholder — see Step 4).

- [ ] **Step 1: Create the sign-in server action**

`src/app/actions/auth.ts`:
```typescript
"use server";
import { AuthError } from "next-auth";
import { signIn, signOut } from "@/auth";

export async function loginAction(_prev: unknown, formData: FormData) {
  try {
    await signIn("credentials", {
      email: formData.get("email"),
      password: formData.get("password"),
      redirectTo: "/",
    });
  } catch (error) {
    if (error instanceof AuthError) return { error: "Invalid email or password." };
    throw error; // re-throw Next.js redirect
  }
}

export async function logoutAction() {
  await signOut({ redirectTo: "/login" });
}
```

- [ ] **Step 2: Create the login page**

`src/app/login/page.tsx`:
```tsx
"use client";
import { useActionState } from "react";
import { loginAction } from "@/app/actions/auth";

export default function LoginPage() {
  const [state, action, pending] = useActionState(loginAction, undefined);
  return (
    <main style={{ maxWidth: 360, margin: "10vh auto", fontFamily: "system-ui" }}>
      <h1>Hand Receipt — Sign in</h1>
      <form action={action}>
        <label>Email<input name="email" type="email" required style={{ width: "100%" }} /></label>
        <label>Password<input name="password" type="password" required style={{ width: "100%" }} /></label>
        {state?.error && <p role="alert" style={{ color: "crimson" }}>{state.error}</p>}
        <button disabled={pending} type="submit">{pending ? "Signing in…" : "Sign in"}</button>
      </form>
    </main>
  );
}
```

- [ ] **Step 3: Create the sign-out button**

`src/components/SignOutButton.tsx`:
```tsx
import { logoutAction } from "@/app/actions/auth";
export function SignOutButton() {
  return (
    <form action={logoutAction}>
      <button type="submit">Sign out</button>
    </form>
  );
}
```

- [ ] **Step 4: Home route redirects by role**

`src/app/page.tsx`:
```tsx
import { redirect } from "next/navigation";
import { auth } from "@/auth";

export default async function Home() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  // Dashboard arrives in Plan 3; admins land on the admin console (Plan 2).
  redirect(session.user.role === "ADMIN" ? "/admin" : "/dashboard");
}
```
Note: `/admin` and `/dashboard` are added in later plans; until then they 404 after login, which is expected at this stage.

- [ ] **Step 5: Manual verification**

Run: `npm run dev`. Visit `http://localhost:3000` → redirected to `/login`. Sign in with the seeded admin → redirected to `/` → `/admin` (404 for now, expected). Wrong password → "Invalid email or password."

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: login page, sign-in/out actions, role-based home redirect"
```

---

### Task 8: E2E smoke — auth gate

**Files:**
- Create: `playwright.config.ts`
- Create: `tests/e2e/auth.spec.ts`

**Interfaces:**
- Consumes: running dev server + seeded admin.

- [ ] **Step 1: Create playwright.config.ts**

```typescript
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  use: { baseURL: "http://localhost:3000" },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000/login",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
```

- [ ] **Step 2: Write the E2E test**

`tests/e2e/auth.spec.ts`:
```typescript
import { expect, test } from "@playwright/test";

test("unauthenticated user is redirected to login", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
});

test("admin can sign in", async ({ page }) => {
  await page.goto("/login");
  await page.fill('input[name="email"]', "admin@example.com");
  await page.fill('input[name="password"]', "ChangeMe123!");
  await page.click('button[type="submit"]');
  await expect(page).not.toHaveURL(/\/login/);
});
```

- [ ] **Step 3: Run E2E**

Run: `npx playwright install --with-deps chromium && npx playwright test`
Expected: 2 passed. (Ensure db is seeded first: `npm run db:seed`.)

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test: e2e auth gate and admin sign-in"
```

---

## Self-Review

- **Spec coverage:** Roles (ADMIN/USER) ✅ Task 2/5. Email+password auth ✅ Task 3/4/7. No self-registration ✅ (login only). Seeded admin ✅ Task 6. Server-side authz ✅ Task 5. Postgres/Prisma/Next.js/Auth.js stack ✅. (Items, transfers, QR, signatures are Plans 2–3.)
- **Placeholders:** none — every step has concrete code/commands. `/admin` and `/dashboard` 404 is an explicitly-noted interim state, not a placeholder in the code.
- **Type consistency:** `SessionUser`/`Role` used consistently across `next-auth.d.ts`, `authz.ts`, `auth.ts`. `hashPassword`/`verifyPassword` names match between Tasks 3, 4, 6.
