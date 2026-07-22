# Public-access PIN Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate the public surface (`/`, `/i/*`, `/receipts/*`) behind a shared, admin-settable 8-digit PIN for logged-out visitors, while logged-in staff bypass and recipients stay unlocked for 7 days.

**Architecture:** A Next.js 16 `proxy` (formerly `middleware`) at `src/proxy.ts` is the single edge choke point. It lets verified logged-in users through (`getToken`, no DB), accepts a self-contained HMAC-signed `pub_unlock` cookie, and otherwise redirects to `/unlock`. The PIN is bcrypt-hashed in a new single-row `PublicAccessSetting` table, set from `/admin`. A `PUBLIC_ACCESS_PIN_ENABLED` env flag turns the whole gate on/off (rollout + kill-switch). Because the edge proxy cannot read the DB per request, the unlock cookie is signed with `AUTH_SECRET` and self-verifies.

**Tech Stack:** Next.js 16 (App Router, `proxy` convention), Auth.js v5 (`next-auth/jwt` `getToken`), Prisma 7 / PostgreSQL, `bcryptjs`, Zod, Web Crypto (`crypto.subtle`) at the edge, Vitest.

## Global Constraints

- **This is NOT the Next.js you know** (AGENTS.md): the `middleware` convention is **deprecated → renamed to `proxy`**. The file is `src/proxy.ts`, exports `proxy` + `config` with `matcher`. Read `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md` before editing it.
- **`src/proxy.ts` ALREADY EXISTS and MUST be merged, not overwritten.** It is `export { auth as proxy } from "@/auth"` — the app's existing session-auth boundary (auth-gates `/items`, `/admin/*`, `/account`, … via a negative-lookahead matcher that excludes the public routes + login/privacy/terms/assets). Task 5 folds the PIN gate into this same file. Overwriting it would delete the auth boundary — a severe regression.
- **Runtime:** Next 16 `proxy` runs on the **Node.js runtime** (the `runtime` option is not configurable and throws if set; edge is not available). So `src/proxy.ts` may freely import Node modules — this is why the existing `export { auth as proxy }` (which transitively pulls in Prisma/`pg`) bundles fine. `src/lib/public-access-cookie.ts` still uses only Web Crypto (`crypto.subtle`, `btoa`, `TextEncoder`) and imports nothing — a deliberate portability choice (also usable from Node), NOT a hard runtime requirement. Tasks 1–4 need no change.
- **The proxy is NOT an authz boundary.** Do not move any `requireUser`/`requireAdmin` logic into it. All existing per-route authz stays exactly where it is. The proxy only (a) keeps the existing coarse login gate and (b) gates the public PII surface behind the PIN.
- **Every Server Action starts with `requireUser()`/`requireAdmin()`** except the intentionally public `unlockAction` (which gates on the PIN itself).
- **Secrets:** reuse `process.env.AUTH_SECRET` for cookie signing (already present). Never hardcode. Prod detection: `process.env.NODE_ENV === "production"`.
- **Docs ship with the code** (CLAUDE.md non-negotiable): CLAUDE.md, CHANGELOG.md, README.md, `.env.example` are updated in this plan (Task 6), committed with the feature.
- **Migrations:** `prisma migrate dev` cannot run in this shell (repo memory). Hand-author `migration.sql`, then `npx prisma migrate deploy` locally + `npx prisma generate`. Prod is applied separately at rollout via the Supabase MCP.
- **Tests share one DB** (repo memory): run `npm test` **solo**, never in parallel with another agent. jsdom has no layout engine — verify any UI/layout in a real browser, not via tests or `next build`.
- **Reuse existing CSS classes** seen in `NewUserForm.tsx` / admin page: `card`, `stack`, `stack-sm`, `field`, `form-grid`, `label`, `input`, `btn`, `btn-primary`, `row`, `alert-error`, `alert-success`, `page-title`, `subtle`.

---

## File structure

**Create:**
- `src/lib/public-access-cookie.ts` — edge-safe: cookie name, HMAC sign/verify, `sanitizeNext`, `shouldAllowPublic`, TTL constants. (Task 2)
- `src/lib/public-access-cookie.test.ts` — unit tests for the above. (Task 2)
- `src/lib/public-access.ts` — Node/server-only: `getPinHash`, `verifyPin`, `setPin`, `getPinMeta` (bcrypt + Prisma). (Task 1)
- `src/lib/public-access.test.ts` — unit tests (mocked Prisma + password). (Task 1)
- `src/app/actions/unlock.ts` — public `unlockAction` server action. (Task 3)
- `src/app/actions/unlock.test.ts` — unit tests. (Task 3)
- `src/app/unlock/page.tsx` — the PIN entry page. (Task 3)
- `src/app/unlock/UnlockForm.tsx` — client form. (Task 3)
- `src/app/admin/actions/public-access.ts` — `setPublicAccessPinAction`. (Task 4)
- `src/app/admin/actions/public-access.test.ts` — unit tests. (Task 4)
- `src/app/admin/PublicAccessPinForm.tsx` — client form for admin. (Task 4)
- `prisma/migrations/20260721170000_public_access_setting/migration.sql` — DDL. (Task 1)

**Modify:**
- `prisma/schema.prisma` — add `PublicAccessSetting` model + `User` back-relation. (Task 1)
- `src/app/admin/page.tsx` — add the "Public access PIN" section. (Task 4)
- `src/proxy.ts` — **merge** the PIN gate into the app's existing proxy (do NOT overwrite it). (Task 5)
- `CLAUDE.md`, `CHANGELOG.md`, `README.md`, `.env.example` — docs. (Task 6)

---

## Task 1: PIN storage — model, migration, Node service

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260721170000_public_access_setting/migration.sql`
- Create: `src/lib/public-access.ts`
- Test: `src/lib/public-access.test.ts`

**Interfaces:**
- Consumes: `@/lib/prisma` (default export `prisma`), `@/lib/password` (`hashPassword`, `verifyPassword`).
- Produces:
  - `getPinHash(): Promise<string | null>`
  - `verifyPin(pin: string): Promise<boolean>`
  - `setPin(pin: string, userId: string): Promise<void>`
  - `getPinMeta(): Promise<{ updatedAt: Date; updatedByName: string | null } | null>`

- [ ] **Step 1: Add the Prisma model + back-relation**

In `prisma/schema.prisma`, add to the `User` model's relation list (near the other `@relation` back-references, e.g. after `createdContacts`):

```prisma
  publicAccessUpdates PublicAccessSetting[] @relation("PinUpdates")
```

And add this model at the end of the file:

```prisma
// Single-row org config for the public-access PIN gate. `id` is pinned to
// "singleton" so there is exactly one row (upserted). Stores only the bcrypt
// hash of the 8-digit PIN — never the PIN. `updatedBy` is nullable + SetNull so
// the row survives deletion of the admin who last set it (mirrors ItemEdit).
// New tables inherit RLS-enabled/deny-all via the rls_auto_enable trigger; the
// app reaches this only through Prisma (see CLAUDE.md §6).
model PublicAccessSetting {
  id          String   @id @default("singleton")
  pinHash     String
  updatedAt   DateTime @updatedAt
  updatedBy   User?    @relation("PinUpdates", fields: [updatedById], references: [id], onDelete: SetNull)
  updatedById String?

  @@index([updatedById])
}
```

- [ ] **Step 2: Hand-author the migration SQL**

Create `prisma/migrations/20260721170000_public_access_setting/migration.sql`:

```sql
-- Single-row config table for the public-access PIN gate. Stores only the
-- bcrypt hash of the shared 8-digit PIN. RLS is auto-enabled (deny-all) by the
-- rls_auto_enable event trigger; access is app-layer via Prisma only.
CREATE TABLE "PublicAccessSetting" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "pinHash" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,
    CONSTRAINT "PublicAccessSetting_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PublicAccessSetting_updatedById_idx" ON "PublicAccessSetting"("updatedById");

ALTER TABLE "PublicAccessSetting" ADD CONSTRAINT "PublicAccessSetting_updatedById_fkey"
    FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

- [ ] **Step 3: Apply the migration + regenerate the client**

Run:
```bash
npx prisma migrate deploy && npx prisma generate
```
Expected: `migrate deploy` reports `1 migration applied` (the `20260721170000_public_access_setting` migration), and `generate` succeeds so `prisma.publicAccessSetting` is typed.

- [ ] **Step 4: Write the failing test**

Create `src/lib/public-access.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const findUnique = vi.fn();
const upsert = vi.fn();
const hashPassword = vi.fn();
const verifyPassword = vi.fn();

vi.mock("@/lib/prisma", () => ({
  default: { publicAccessSetting: { findUnique: (a: unknown) => findUnique(a), upsert: (a: unknown) => upsert(a) } },
}));
vi.mock("@/lib/password", () => ({
  hashPassword: (p: string) => hashPassword(p),
  verifyPassword: (p: string, h: string) => verifyPassword(p, h),
}));

import { getPinHash, verifyPin, setPin, getPinMeta } from "./public-access";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("verifyPin", () => {
  it("returns false when no PIN is configured", async () => {
    findUnique.mockResolvedValue(null);
    expect(await verifyPin("12345678")).toBe(false);
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it("bcrypt-compares against the stored hash when configured", async () => {
    findUnique.mockResolvedValue({ pinHash: "HASH" });
    verifyPassword.mockResolvedValue(true);
    expect(await verifyPin("12345678")).toBe(true);
    expect(verifyPassword).toHaveBeenCalledWith("12345678", "HASH");
  });
});

describe("setPin", () => {
  it("hashes the PIN and upserts the singleton row with the acting admin", async () => {
    hashPassword.mockResolvedValue("HASHED");
    await setPin("87654321", "admin-1");
    expect(hashPassword).toHaveBeenCalledWith("87654321");
    const arg = upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ id: "singleton" });
    expect(arg.create).toMatchObject({ id: "singleton", pinHash: "HASHED", updatedById: "admin-1" });
    expect(arg.update).toMatchObject({ pinHash: "HASHED", updatedById: "admin-1" });
  });
});

describe("getPinMeta", () => {
  it("returns null when unset", async () => {
    findUnique.mockResolvedValue(null);
    expect(await getPinMeta()).toBeNull();
  });

  it("returns updatedAt + updater name", async () => {
    const when = new Date("2026-07-21T00:00:00Z");
    findUnique.mockResolvedValue({ updatedAt: when, updatedBy: { name: "Jane" } });
    expect(await getPinMeta()).toEqual({ updatedAt: when, updatedByName: "Jane" });
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `npx vitest run src/lib/public-access.test.ts`
Expected: FAIL — cannot import `./public-access` (module does not exist).

- [ ] **Step 6: Write the implementation**

Create `src/lib/public-access.ts`:

```ts
import "server-only"; // bcrypt + Prisma must never reach the client/edge bundle
import prisma from "@/lib/prisma";
import { hashPassword, verifyPassword } from "@/lib/password";

// Single-row config: one shared org PIN. Pinned id keeps it to one row.
const SINGLETON_ID = "singleton";

export async function getPinHash(): Promise<string | null> {
  const row = await prisma.publicAccessSetting.findUnique({
    where: { id: SINGLETON_ID },
    select: { pinHash: true },
  });
  return row?.pinHash ?? null;
}

export async function verifyPin(pin: string): Promise<boolean> {
  const hash = await getPinHash();
  if (!hash) return false; // no PIN configured -> nothing verifies
  return verifyPassword(pin, hash);
}

export async function setPin(pin: string, userId: string): Promise<void> {
  const pinHash = await hashPassword(pin);
  await prisma.publicAccessSetting.upsert({
    where: { id: SINGLETON_ID },
    create: { id: SINGLETON_ID, pinHash, updatedById: userId },
    update: { pinHash, updatedById: userId },
  });
}

export async function getPinMeta(): Promise<{ updatedAt: Date; updatedByName: string | null } | null> {
  const row = await prisma.publicAccessSetting.findUnique({
    where: { id: SINGLETON_ID },
    select: { updatedAt: true, updatedBy: { select: { name: true } } },
  });
  if (!row) return null;
  return { updatedAt: row.updatedAt, updatedByName: row.updatedBy?.name ?? null };
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run src/lib/public-access.test.ts`
Expected: PASS (all cases).

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260721170000_public_access_setting src/lib/public-access.ts src/lib/public-access.test.ts
git commit -m "feat: add PublicAccessSetting model + PIN service"
```

---

## Task 2: Edge-safe cookie & decision helpers

**Files:**
- Create: `src/lib/public-access-cookie.ts`
- Test: `src/lib/public-access-cookie.test.ts`

**Interfaces:**
- Consumes: Web Crypto globals only (`crypto.subtle`, `btoa`, `TextEncoder`). No app imports.
- Produces:
  - `UNLOCK_MAX_AGE_SECONDS: number` (604800), `UNLOCK_TTL_MS: number` (604800000)
  - `unlockCookieName(secure: boolean): string`
  - `signUnlockValue(expMs: number, secret: string): Promise<string>`
  - `verifyUnlockValue(value: string | undefined, secret: string, nowMs: number): Promise<boolean>`
  - `sanitizeNext(next: string | null | undefined): string`
  - `shouldAllowPublic(opts: { flagEnabled: boolean; loggedIn: boolean; unlockValid: boolean }): boolean`

- [ ] **Step 1: Write the failing test**

Create `src/lib/public-access-cookie.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  signUnlockValue,
  verifyUnlockValue,
  sanitizeNext,
  shouldAllowPublic,
  unlockCookieName,
  UNLOCK_TTL_MS,
} from "./public-access-cookie";

const SECRET = "test-secret-abc";

describe("unlock cookie sign/verify", () => {
  it("round-trips a valid, unexpired value", async () => {
    const now = 1_000_000;
    const value = await signUnlockValue(now + UNLOCK_TTL_MS, SECRET);
    expect(await verifyUnlockValue(value, SECRET, now)).toBe(true);
  });

  it("rejects an expired value", async () => {
    const now = 1_000_000;
    const value = await signUnlockValue(now - 1, SECRET);
    expect(await verifyUnlockValue(value, SECRET, now)).toBe(false);
  });

  it("rejects a tampered signature", async () => {
    const now = 1_000_000;
    const value = await signUnlockValue(now + UNLOCK_TTL_MS, SECRET);
    const tampered = value.slice(0, -2) + (value.endsWith("aa") ? "bb" : "aa");
    expect(await verifyUnlockValue(tampered, SECRET, now)).toBe(false);
  });

  it("rejects a value signed with a different secret", async () => {
    const now = 1_000_000;
    const value = await signUnlockValue(now + UNLOCK_TTL_MS, SECRET);
    expect(await verifyUnlockValue(value, "other-secret", now)).toBe(false);
  });

  it("rejects undefined/garbage", async () => {
    expect(await verifyUnlockValue(undefined, SECRET, 0)).toBe(false);
    expect(await verifyUnlockValue("nodot", SECRET, 0)).toBe(false);
    expect(await verifyUnlockValue(".sig", SECRET, 0)).toBe(false);
  });
});

describe("sanitizeNext", () => {
  it("keeps a same-origin relative path", () => {
    expect(sanitizeNext("/i/abc123")).toBe("/i/abc123");
    expect(sanitizeNext("/receipts/HR-000001?x=1")).toBe("/receipts/HR-000001?x=1");
  });
  it("rejects protocol-relative and absolute URLs", () => {
    expect(sanitizeNext("//evil.com")).toBe("/");
    expect(sanitizeNext("https://evil.com")).toBe("/");
    expect(sanitizeNext("/\\evil.com")).toBe("/");
  });
  it("rejects non-strings and the unlock page itself", () => {
    expect(sanitizeNext(null)).toBe("/");
    expect(sanitizeNext(undefined)).toBe("/");
    expect(sanitizeNext("relative")).toBe("/");
    expect(sanitizeNext("/unlock")).toBe("/");
    expect(sanitizeNext("/unlock?next=/x")).toBe("/");
  });
});

describe("shouldAllowPublic", () => {
  it("allows everything when the flag is off", () => {
    expect(shouldAllowPublic({ flagEnabled: false, loggedIn: false, unlockValid: false })).toBe(true);
  });
  it("with flag on, allows logged-in or unlocked, blocks otherwise", () => {
    expect(shouldAllowPublic({ flagEnabled: true, loggedIn: true, unlockValid: false })).toBe(true);
    expect(shouldAllowPublic({ flagEnabled: true, loggedIn: false, unlockValid: true })).toBe(true);
    expect(shouldAllowPublic({ flagEnabled: true, loggedIn: false, unlockValid: false })).toBe(false);
  });
});

describe("unlockCookieName", () => {
  it("uses the __Secure- prefix only when secure", () => {
    expect(unlockCookieName(true)).toBe("__Secure-pub_unlock");
    expect(unlockCookieName(false)).toBe("pub_unlock");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/public-access-cookie.test.ts`
Expected: FAIL — cannot import `./public-access-cookie`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/public-access-cookie.ts`:

```ts
// EDGE-SAFE. Imported by src/proxy.ts (edge runtime) AND by Node server actions.
// Web Crypto only — do NOT import bcrypt, Prisma, node:crypto, or server-only here.

export const UNLOCK_MAX_AGE_SECONDS = 7 * 24 * 60 * 60; // 7 days
export const UNLOCK_TTL_MS = UNLOCK_MAX_AGE_SECONDS * 1000;

// Mirror Auth.js's cookie-prefix convention: __Secure- over HTTPS.
export function unlockCookieName(secure: boolean): string {
  return secure ? "__Secure-pub_unlock" : "pub_unlock";
}

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(secret: string, msg: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return base64url(new Uint8Array(sig));
}

// Length-checked constant-time string compare (avoids early-exit timing leak).
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

// Cookie value = "<expMs>.<hmac(secret, expMs)>". Self-contained so the edge
// proxy can verify it with no DB lookup.
export async function signUnlockValue(expMs: number, secret: string): Promise<string> {
  const sig = await hmac(secret, String(expMs));
  return `${expMs}.${sig}`;
}

export async function verifyUnlockValue(
  value: string | undefined,
  secret: string,
  nowMs: number,
): Promise<boolean> {
  if (!value) return false;
  const dot = value.indexOf(".");
  if (dot <= 0) return false;
  const expStr = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (!sig) return false;
  const expMs = Number(expStr);
  if (!Number.isFinite(expMs) || expMs <= nowMs) return false;
  const expected = await hmac(secret, expStr);
  return safeEqual(sig, expected);
}

// Only a same-origin relative path is a safe redirect target (prevents open
// redirect). Reject the unlock page itself to avoid a pointless self-redirect.
export function sanitizeNext(next: string | null | undefined): string {
  if (typeof next !== "string") return "/";
  if (!next.startsWith("/")) return "/";
  if (next.startsWith("//") || next.startsWith("/\\")) return "/";
  if (next === "/unlock" || next.startsWith("/unlock?") || next.startsWith("/unlock/")) return "/";
  return next;
}

export function shouldAllowPublic(opts: {
  flagEnabled: boolean;
  loggedIn: boolean;
  unlockValid: boolean;
}): boolean {
  if (!opts.flagEnabled) return true; // gate disabled -> behave like today
  return opts.loggedIn || opts.unlockValid;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/public-access-cookie.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/public-access-cookie.ts src/lib/public-access-cookie.test.ts
git commit -m "feat: add edge-safe unlock-cookie + access-decision helpers"
```

---

## Task 3: `/unlock` page + `unlockAction`

**Files:**
- Create: `src/app/actions/unlock.ts`
- Test: `src/app/actions/unlock.test.ts`
- Create: `src/app/unlock/page.tsx`
- Create: `src/app/unlock/UnlockForm.tsx`

**Interfaces:**
- Consumes: `verifyPin` (Task 1); `signUnlockValue`, `unlockCookieName`, `sanitizeNext`, `UNLOCK_MAX_AGE_SECONDS`, `UNLOCK_TTL_MS` (Task 2); `cookies` (`next/headers`), `redirect` (`next/navigation`).
- Produces: `unlockAction(_prev: unknown, formData: FormData): Promise<{ error: string } | never>` (returns `{ error }` on failure; on success it sets the cookie and `redirect()`s, which throws).

- [ ] **Step 1: Write the failing test**

Create `src/app/actions/unlock.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const verifyPin = vi.fn();
const cookieSet = vi.fn();
const redirect = vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); });

vi.mock("@/lib/public-access", () => ({ verifyPin: (p: string) => verifyPin(p) }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: (...a: unknown[]) => cookieSet(...a) }) }));
vi.mock("next/navigation", () => ({ redirect: (u: string) => redirect(u) }));

import { unlockAction } from "./unlock";

function fd(entries: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_SECRET = "test-secret";
});

describe("unlockAction", () => {
  it("rejects a non-8-digit PIN without hitting verifyPin", async () => {
    const res = await unlockAction(undefined, fd({ pin: "12ab", next: "/i/x" }));
    expect(res).toEqual({ error: "Enter the 8-digit PIN." });
    expect(verifyPin).not.toHaveBeenCalled();
  });

  it("returns a generic error on an incorrect PIN", async () => {
    verifyPin.mockResolvedValue(false);
    const res = await unlockAction(undefined, fd({ pin: "00000000", next: "/i/x" }));
    expect(res).toEqual({ error: "Incorrect PIN." });
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it("sets the unlock cookie and redirects to the sanitized next on success", async () => {
    verifyPin.mockResolvedValue(true);
    await expect(unlockAction(undefined, fd({ pin: "12345678", next: "/i/abc" })))
      .rejects.toThrow("REDIRECT:/i/abc");
    expect(cookieSet).toHaveBeenCalledTimes(1);
    const [name, value, opts] = cookieSet.mock.calls[0];
    expect(name).toBe("pub_unlock"); // NODE_ENV is "test" -> not secure
    expect(typeof value).toBe("string");
    expect(opts).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", maxAge: 604800 });
  });

  it("redirects to / when next is an open-redirect attempt", async () => {
    verifyPin.mockResolvedValue(true);
    await expect(unlockAction(undefined, fd({ pin: "12345678", next: "https://evil.com" })))
      .rejects.toThrow("REDIRECT:/");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/actions/unlock.test.ts`
Expected: FAIL — cannot import `./unlock`.

- [ ] **Step 3: Write the action**

Create `src/app/actions/unlock.ts`:

```ts
"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { verifyPin } from "@/lib/public-access";
import {
  signUnlockValue,
  unlockCookieName,
  sanitizeNext,
  UNLOCK_MAX_AGE_SECONDS,
  UNLOCK_TTL_MS,
} from "@/lib/public-access-cookie";

// PUBLIC BY DESIGN: this is the one server action with no requireUser — it gates
// on the PIN itself. Verifies the 8-digit PIN against the bcrypt hash, then mints
// a 7-day HMAC-signed unlock cookie the edge proxy can self-verify.
const schema = z.object({ pin: z.string().regex(/^\d{8}$/), next: z.string().optional() });

export async function unlockAction(_prev: unknown, formData: FormData) {
  const parsed = schema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Enter the 8-digit PIN." };

  const ok = await verifyPin(parsed.data.pin);
  if (!ok) {
    // Slow down online guessing; also masks "no PIN set" vs "wrong PIN".
    await new Promise((r) => setTimeout(r, 400));
    return { error: "Incorrect PIN." };
  }

  const secret = process.env.AUTH_SECRET ?? "";
  const secure = process.env.NODE_ENV === "production";
  const value = await signUnlockValue(Date.now() + UNLOCK_TTL_MS, secret);
  const store = await cookies();
  store.set(unlockCookieName(secure), value, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: UNLOCK_MAX_AGE_SECONDS,
  });

  redirect(sanitizeNext(parsed.data.next));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/actions/unlock.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the client form**

Create `src/app/unlock/UnlockForm.tsx`:

```tsx
"use client";
import { useActionState } from "react";
import { unlockAction } from "@/app/actions/unlock";

export function UnlockForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState(unlockAction, undefined);
  return (
    <form action={action} className="stack-sm">
      <input type="hidden" name="next" value={next} />
      <div className="field">
        <label className="label" htmlFor="pin">Access PIN</label>
        <input
          id="pin"
          className="input"
          name="pin"
          inputMode="numeric"
          autoComplete="off"
          pattern="\d{8}"
          maxLength={8}
          placeholder="8-digit PIN"
          required
          autoFocus
        />
      </div>
      <div className="row">
        <button disabled={pending} type="submit" className="btn btn-primary">
          {pending ? "Checking…" : "View receipts"}
        </button>
        {state?.error && <span role="alert" className="alert-error">{state.error}</span>}
      </div>
    </form>
  );
}
```

- [ ] **Step 6: Write the page**

Create `src/app/unlock/page.tsx`:

```tsx
import Link from "next/link";
import { SiteHeader } from "@/components/SiteHeader";
import { sanitizeNext } from "@/lib/public-access-cookie";
import { UnlockForm } from "./UnlockForm";

export default async function UnlockPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const sp = await searchParams;
  const next = sanitizeNext(sp.next ?? "/");
  return (
    <>
      <SiteHeader />
      <main className="container container-mid stack">
        <div>
          <h1 className="page-title">Enter the access PIN</h1>
          <p className="subtle">
            Access to hand receipts and item records is protected. Enter the 8-digit PIN to continue.
          </p>
        </div>
        <div className="card">
          <UnlockForm next={next} />
        </div>
        <p className="subtle">
          Staff? <Link href="/login">Log in</Link> instead.
        </p>
      </main>
    </>
  );
}
```

- [ ] **Step 7: Verify the build compiles the new route**

Run: `npx tsc --noEmit`
Expected: PASS (no type errors). (`/unlock` UI layout is verified in a real browser in Task 5.)

- [ ] **Step 8: Commit**

```bash
git add src/app/actions/unlock.ts src/app/actions/unlock.test.ts src/app/unlock
git commit -m "feat: add /unlock PIN entry page and unlockAction"
```

---

## Task 4: Admin PIN management

**Files:**
- Create: `src/app/admin/actions/public-access.ts`
- Test: `src/app/admin/actions/public-access.test.ts`
- Create: `src/app/admin/PublicAccessPinForm.tsx`
- Modify: `src/app/admin/page.tsx`

**Interfaces:**
- Consumes: `requireAdmin` (`@/lib/authz`), `setPin` + `getPinMeta` (Task 1), `revalidatePath` (`next/cache`).
- Produces: `setPublicAccessPinAction(_prev: unknown, formData: FormData): Promise<{ error: string } | { ok: true }>`.

- [ ] **Step 1: Write the failing test**

Create `src/app/admin/actions/public-access.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const requireAdmin = vi.fn();
const setPin = vi.fn();
const revalidatePath = vi.fn();

vi.mock("@/lib/authz", () => ({ requireAdmin: () => requireAdmin() }));
vi.mock("@/lib/public-access", () => ({ setPin: (p: string, u: string) => setPin(p, u) }));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));

import { setPublicAccessPinAction } from "./public-access";

const ADMIN = { id: "admin-1", role: "ADMIN" as const, name: "Admin", email: "a@x.mil" };

function fd(entries: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAdmin.mockResolvedValue(ADMIN);
  setPin.mockResolvedValue(undefined);
});

describe("setPublicAccessPinAction", () => {
  it("requires admin (propagates the authz error)", async () => {
    requireAdmin.mockRejectedValue(new Error("FORBIDDEN"));
    await expect(setPublicAccessPinAction(undefined, fd({ pin: "12345678", confirm: "12345678" })))
      .rejects.toThrow("FORBIDDEN");
    expect(setPin).not.toHaveBeenCalled();
  });

  it("rejects a non-8-digit PIN", async () => {
    const res = await setPublicAccessPinAction(undefined, fd({ pin: "123", confirm: "123" }));
    expect(res).toEqual({ error: "PIN must be exactly 8 digits." });
    expect(setPin).not.toHaveBeenCalled();
  });

  it("rejects a mismatched confirmation", async () => {
    const res = await setPublicAccessPinAction(undefined, fd({ pin: "12345678", confirm: "87654321" }));
    expect(res).toEqual({ error: "PINs do not match." });
    expect(setPin).not.toHaveBeenCalled();
  });

  it("sets the PIN with the acting admin id and revalidates /admin", async () => {
    const res = await setPublicAccessPinAction(undefined, fd({ pin: "12345678", confirm: "12345678" }));
    expect(res).toEqual({ ok: true });
    expect(setPin).toHaveBeenCalledWith("12345678", "admin-1");
    expect(revalidatePath).toHaveBeenCalledWith("/admin");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/admin/actions/public-access.test.ts`
Expected: FAIL — cannot import `./public-access`.

- [ ] **Step 3: Write the action**

Create `src/app/admin/actions/public-access.ts`:

```ts
"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/authz";
import { setPin } from "@/lib/public-access";

const schema = z
  .object({
    pin: z.string().regex(/^\d{8}$/, "PIN must be exactly 8 digits."),
    confirm: z.string(),
  })
  .refine((d) => d.pin === d.confirm, { message: "PINs do not match.", path: ["confirm"] });

export async function setPublicAccessPinAction(_prev: unknown, formData: FormData) {
  const admin = await requireAdmin();
  const parsed = schema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  await setPin(parsed.data.pin, admin.id);
  revalidatePath("/admin");
  return { ok: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/admin/actions/public-access.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the admin client form**

Create `src/app/admin/PublicAccessPinForm.tsx`:

```tsx
"use client";
import { useActionState } from "react";
import { setPublicAccessPinAction } from "@/app/admin/actions/public-access";

export function PublicAccessPinForm() {
  const [state, action, pending] = useActionState(setPublicAccessPinAction, undefined);
  return (
    <form action={action} className="stack-sm">
      <div className="form-grid">
        <div className="field">
          <label className="label" htmlFor="pa-pin">New 8-digit PIN</label>
          <input
            id="pa-pin"
            className="input"
            name="pin"
            inputMode="numeric"
            autoComplete="off"
            pattern="\d{8}"
            maxLength={8}
            placeholder="8 digits"
            required
          />
        </div>
        <div className="field">
          <label className="label" htmlFor="pa-confirm">Confirm PIN</label>
          <input
            id="pa-confirm"
            className="input"
            name="confirm"
            inputMode="numeric"
            autoComplete="off"
            pattern="\d{8}"
            maxLength={8}
            placeholder="re-enter"
            required
          />
        </div>
      </div>
      <div className="row">
        <button disabled={pending} type="submit" className="btn btn-primary">
          {pending ? "Saving…" : "Set PIN"}
        </button>
        {state?.error && <span role="alert" className="alert-error">{state.error}</span>}
        {state && "ok" in state && state.ok && <span className="alert-success">PIN updated.</span>}
      </div>
    </form>
  );
}
```

- [ ] **Step 6: Add the section to the admin dashboard**

In `src/app/admin/page.tsx`:

Add imports at the top (after the existing imports):
```tsx
import { getPinMeta } from "@/lib/public-access";
import { PublicAccessPinForm } from "./PublicAccessPinForm";
```

In `AdminHome`, after the existing `getTimerDashboard()` call, add:
```tsx
  const pinMeta = await getPinMeta();
```

Then add this `<section>` just before the closing `</div>` of the returned markup (after the "Manage" section):
```tsx
      <section className="card stack-sm">
        <h2>Public access PIN</h2>
        <p className="subtle">
          Logged-out visitors must enter this 8-digit PIN to search or view hand receipts and item
          records (when the gate is enabled). Rotating it stops new unlocks immediately; visitors
          already unlocked stay in for up to 7 days.
        </p>
        <p className="subtle">
          {pinMeta
            ? `Last changed ${pinMeta.updatedAt.toLocaleDateString()}${pinMeta.updatedByName ? ` by ${pinMeta.updatedByName}` : ""}.`
            : "No PIN set yet."}
        </p>
        <PublicAccessPinForm />
      </section>
```

- [ ] **Step 7: Verify types compile**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/app/admin/actions/public-access.ts src/app/admin/actions/public-access.test.ts src/app/admin/PublicAccessPinForm.tsx src/app/admin/page.tsx
git commit -m "feat: add admin Public access PIN management"
```

---

## Task 5: The `proxy` gate + end-to-end verification

**Files:**
- Modify: `src/proxy.ts` (the app's existing proxy — MERGE, do not overwrite)

**Interfaces:**
- Consumes: `shouldAllowPublic`, `verifyUnlockValue`, `unlockCookieName`, `sanitizeNext` (Task 2); `auth` (`@/auth`, the existing Auth.js instance); `NextResponse` (`next/server`).
- Produces: `proxy` (the `auth()`-wrapped handler) + `config.matcher` (Next.js reads these by convention; nothing imports them).

- [ ] **Step 1: Read the existing proxy AND the Next 16 proxy doc**

Run: `cat src/proxy.ts` and `sed -n '1,60p;210,240p' node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`

Confirm and internalize:
- The current `src/proxy.ts` is `export { auth as proxy } from "@/auth"` with a matcher that auth-gates everything EXCEPT a negative-lookahead exclusion list: `api/auth`, `api/cron`, `login`, `forgot-password`, `reset-password`, `privacy`, `terms`, `receipts/`, `i/`, `_next/static`, `_next/image`, `favicon.ico`, `wasm/`, and `$` (bare root). Those excluded paths are the app's public + asset surface.
- Next 16 `proxy` runs on the **Node.js runtime**; the `runtime` option is not configurable (throws if set). So Node imports (Prisma via `@/auth`) are fine.

You are MERGING the PIN gate into this file — keeping the existing login-gate behavior for the currently-gated routes, and adding the PIN gate for the public routes.

- [ ] **Step 2: Rewrite `src/proxy.ts` as the merged gate**

Replace the entire contents of `src/proxy.ts` with:

```ts
import { auth } from "@/auth";
import { NextResponse } from "next/server";
import {
  shouldAllowPublic,
  verifyUnlockValue,
  unlockCookieName,
  sanitizeNext,
} from "@/lib/public-access-cookie";

// This proxy carries TWO gates in one file (Next 16 allows a single proxy
// export). Next 16 `proxy` (renamed from `middleware`) runs on the Node.js
// runtime, so `@/auth` (which pulls in Prisma/pg) bundles fine.
//
//  1. Public PII surface (`/`, `/i/*`, `/receipts/*`): the shared 8-digit PIN
//     gate, active only when PUBLIC_ACCESS_PIN_ENABLED is on. A logged-in user
//     OR a valid unlock cookie passes; otherwise redirect to /unlock. This is
//     NOT an authz boundary — real authz stays per-route (requireUser/
//     requireAdmin).
//  2. Every other matched route (`/items`, `/admin/*`, `/account`, …): the
//     app's pre-existing coarse login gate — a session is required, else
//     redirect to /login. `auth()` populates `req.auth` (null if the session
//     is absent or was revoked), preserving the prior behavior.
//
// The matcher excludes `/unlock` (else a logged-out visitor would be bounced
// off the PIN page itself) plus the other public/asset paths. It now RUNS on
// `/`, `/i/*`, `/receipts/*` (previously excluded) so the PIN gate can see them.
export const proxy = auth(async (req) => {
  const { pathname, search } = req.nextUrl;
  const loggedIn = !!req.auth;

  const isPublicPii =
    pathname === "/" ||
    pathname.startsWith("/i/") ||
    pathname.startsWith("/receipts/");

  if (isPublicPii) {
    const flagEnabled = process.env.PUBLIC_ACCESS_PIN_ENABLED === "true";
    const secret = process.env.AUTH_SECRET ?? "";
    const secure = process.env.NODE_ENV === "production";
    const cookieValue = req.cookies.get(unlockCookieName(secure))?.value;
    const unlockValid = await verifyUnlockValue(cookieValue, secret, Date.now());
    if (shouldAllowPublic({ flagEnabled, loggedIn, unlockValid })) {
      return NextResponse.next();
    }
    const url = new URL("/unlock", req.url);
    url.searchParams.set("next", sanitizeNext(pathname + search));
    return NextResponse.redirect(url);
  }

  // Existing coarse login gate for all other matched routes.
  if (!loggedIn) {
    return NextResponse.redirect(new URL("/login", req.url));
  }
  return NextResponse.next();
});

export const config = {
  // Same negative-lookahead as before, with three changes: `receipts/`, `i/`,
  // and the bare-root `$` are REMOVED (so the proxy now runs on the public PII
  // routes to PIN-gate them), and `unlock` is ADDED (so the PIN page stays
  // reachable). `wasm/` etc. stay excluded — see the prior comment history.
  matcher: ["/((?!api/auth|api/cron|login|forgot-password|reset-password|privacy|terms|unlock|_next/static|_next/image|favicon.ico|wasm/).*)"],
};
```

Note: `privacy` and `terms` stay excluded (public, no PII — they should not require a PIN). The authed sub-routes under `/receipts/*` and `/i/*` (`/receipts/new`, `/receipts/<n>/return`, `/i/<id>/qr/pdf`) already self-guard with `requireUser`; routing them through the PIN gate does not change that (logged-in staff bypass; logged-out users hit /unlock then still need /login).

- [ ] **Step 3: Confirm types + lint + the whole suite**

Run these SEPARATELY (do NOT `&&`-chain — tsc has a pre-existing non-clean baseline):
- `npx tsc --noEmit` — confirm no NEW errors reference `src/proxy.ts` (the ~22 pre-existing errors in unrelated `.test.ts` files are expected).
- `npm run lint` — expect clean.
- `npm test` — the full Vitest suite, run SOLO (shared test DB). Report the pass/total; all prior-passing tests plus the PIN tests should pass.

- [ ] **Step 4: End-to-end verification in a real browser (verify skill)**

Use the `verify` skill to build/run the app and drive it. Set `PUBLIC_ACCESS_PIN_ENABLED=true` in `.env.local`, set a PIN via `/admin`, then confirm each row:

| Check | Expected |
|---|---|
| **PIN gate (flag on):** logged-out visitor opens `/` | redirected to `/unlock?next=%2F` |
| Logged-out visitor opens `/i/<id>` | redirected to `/unlock?next=%2Fi%2F<id>` |
| Logged-out visitor opens `/receipts/<num>` and `/receipts/<num>/pdf` | both redirect to `/unlock` |
| Logged-out visitor opens `/unlock` directly | loads the PIN page (NOT a redirect loop) |
| Enter the correct PIN on `/unlock?next=/i/<id>` | lands on `/i/<id>`, item visible; `pub_unlock` cookie set |
| Wrong PIN | "Incorrect PIN.", no cookie, still on `/unlock` |
| After unlock, revisit `/receipts/<num>` | loads directly (cookie honored) |
| Logged-in staff open `/`, `/i/<id>`, `/receipts/<num>` | never see `/unlock` |
| **Existing auth boundary preserved:** logged-out visitor opens `/items` and `/admin` | redirected to `/login` (NOT `/unlock`) |
| Logged-in staff open `/items` and `/admin` | load normally |
| `/privacy` and `/terms` (logged-out) | load normally (no PIN, no login) |
| **Flag off:** set `PUBLIC_ACCESS_PIN_ENABLED=false`, restart | public pages load with no PIN; `/items`/`/admin` still redirect to `/login` (today's behavior) |
| `/unlock` page layout | inspect in the real browser (jsdom has no layout engine) |

Record the result. If any row fails, fix before committing.

- [ ] **Step 5: Commit**

```bash
git add src/proxy.ts
git commit -m "feat: merge public PIN gate into the proxy"
```

---

## Task 6: Documentation, env, and rollout notes

**Files:**
- Modify: `CLAUDE.md`, `CHANGELOG.md`, `README.md`, `.env.example`
- Update repo memory (`MEMORY.md` + a note file).

- [ ] **Step 1: Update the CLAUDE.md accepted-requirement note**

In `CLAUDE.md`, edit the `> **ACCEPTED REQUIREMENT — public, enumerable receipts AND items.**` block. Keep the enumerability tradeoff, but append that the public surface is now **PIN-gated for logged-out users**. Add this sentence at the end of that block:

```markdown
>
> **UPDATE (2026-07-22): the public surface is now behind an 8-digit PIN gate for logged-out users** (`src/proxy.ts`, controlled by `PUBLIC_ACCESS_PIN_ENABLED`). This does NOT change the enumerability tradeoff above — it adds a shared-PIN wall in front of `/`, `/i/*`, and `/receipts/*`. The gate is merged into the existing `src/proxy.ts` (which already coarse-login-gates `/items`, `/admin/*`, etc.); the PIN branch is a **non-authz gate** (it checks the PIN cookie / a logged-in session). Real authz still lives per-route (`requireUser`/`requireAdmin`) and re-reads role/isActive from the DB — the proxy never becomes the authz boundary. Logged-in users bypass the PIN; the PIN is admin-settable from `/admin`.
```

- [ ] **Step 2: Add the CHANGELOG entry**

In `CHANGELOG.md`, add a new top section (newest first):

```markdown
## 2026-07-22

### Added
- Public-access PIN gate: logged-out visitors must enter a shared 8-digit PIN to search inventory or view item / hand-receipt pages. Admins set and rotate the PIN from the admin dashboard; a successful unlock is remembered for 7 days. Logged-in staff are unaffected.

### Security
- The previously open public surface (`/`, `/i/*`, `/receipts/*`, receipt PDFs, and the home search) is now behind the PIN when enabled, reducing casual PII enumeration. Enforcement is merged into the existing `src/proxy.ts` (Node runtime); it is a non-authz gate and does not alter existing role-based authorization or the proxy's pre-existing login gate for `/items`/`/admin/*`.

### Notes
- **New table:** `PublicAccessSetting` (single row, bcrypt-hashed PIN). Migration `20260721170000_public_access_setting`. Apply with `prisma migrate deploy` locally; apply to prod via the Supabase MCP.
- **New env var:** `PUBLIC_ACCESS_PIN_ENABLED` — `"true"` turns the gate on. Default/absent = off (open access, as before). Also the emergency kill-switch.
- **Rollout:** apply the migration → set the PIN in `/admin` → set `PUBLIC_ACCESS_PIN_ENABLED=true` (Vercel + local) and redeploy.
- Rotating the PIN is not retroactive: existing unlock cookies remain valid until they expire (≤7 days). For immediate global revocation, rotate `AUTH_SECRET` (also logs everyone out).
```

- [ ] **Step 3: Document the env var in README**

In `README.md`, add a row to the environment-variables table (after the `AUTH_SECRET` row):

```markdown
| `PUBLIC_ACCESS_PIN_ENABLED` | `"true"` gates the public surface (`/`, `/i/*`, `/receipts/*`) behind the admin-set 8-digit PIN for logged-out users. Absent/`false` = open access. Also the kill-switch. |
```

- [ ] **Step 4: Document the env var in `.env.example`**

In `.env.example`, add:

```bash
# Set to "true" to require an 8-digit PIN for logged-out visitors to view the
# public pages (home search, item pages, receipts). Absent = open access.
# The PIN itself is set in-app at /admin (stored bcrypt-hashed in the DB).
PUBLIC_ACCESS_PIN_ENABLED="false"
```

- [ ] **Step 5: Update repo memory**

Create `C:\Users\xAdmin\.claude\projects\C--inventoryApp\memory\public-pin-gate.md`:

```markdown
---
name: public-pin-gate
description: Public surface is PIN-gated for logged-out users via src/proxy.ts, toggled by PUBLIC_ACCESS_PIN_ENABLED.
metadata:
  type: project
---

Shipped 2026-07-22. Logged-out visitors hit an 8-digit PIN wall (`/unlock`) before `/`, `/i/*`, `/receipts/*`. Merged into the EXISTING `src/proxy.ts` (Next 16 `proxy`, Node runtime) — which already coarse-login-gates `/items`/`/admin/*` via `export {auth as proxy}`; the PIN branch is a non-authz gate, real authz stays per-route. Logged-in staff bypass (via `req.auth` from the `auth()` wrapper). PIN is bcrypt-hashed in `PublicAccessSetting` (single row), admin-set at `/admin`. Unlock cookie is HMAC-signed with `AUTH_SECRET`, 7-day TTL; rotation is not retroactive. Turn on with `PUBLIC_ACCESS_PIN_ENABLED=true` (also the kill-switch). The proxy matcher had `i/`,`receipts/`,`$` removed + `unlock` added. This is the deliberate "harden later if the team asks" path from the CLAUDE.md accepted-requirement note. See [[open-followups]].
```

Add a line to `MEMORY.md` under the index:
```markdown
- [Public PIN gate](public-pin-gate.md) — logged-out visitors need an 8-digit PIN (src/proxy.ts, PUBLIC_ACCESS_PIN_ENABLED); admin-set, 7-day unlock, non-retroactive rotation.
```

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md CHANGELOG.md README.md .env.example
git commit -m "docs: document the public PIN gate, env var, and rollout"
```

---

## Self-review notes

- **Spec coverage:** gate scope (Task 5 matcher), everything-public + logged-in bypass (Task 5), DB-hashed admin-settable PIN (Tasks 1, 4), 7-day unlock (Task 2 constants, Task 3), middleware/proxy enforcement (Task 5), lightweight brute-force delay (Task 3), env kill-switch (Tasks 5, 6), open-redirect safety (Task 2 `sanitizeNext`, used in Tasks 3+5), rotation-not-retroactive tradeoff (documented Tasks 4 UI copy + 6), docs (Task 6). All covered.
- **Rollout / prod migration** (Supabase MCP with CRLF-sha256 checksum row, per repo memory) is an operational step at deploy time, captured in the CHANGELOG Notes + memory; it is not a code task.
- **Type consistency:** `shouldAllowPublic`, `verifyUnlockValue`, `signUnlockValue`, `unlockCookieName`, `sanitizeNext`, `UNLOCK_TTL_MS`, `UNLOCK_MAX_AGE_SECONDS` names match across Tasks 2/3/5; `verifyPin`/`setPin`/`getPinMeta` match across Tasks 1/3/4.
