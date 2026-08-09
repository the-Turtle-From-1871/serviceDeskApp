# Capability Foundation Implementation Plan (PR 1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace two-value role gating with a nine-value capability model, where roles supply a baseline capability set and per-user grants are additive — with zero change to what any existing account can do.

**Architecture:** A `Capability` enum and a `UserCapability` grant table land in Postgres. One pure, DB-free module (`capabilities.ts`) owns the role→capability mapping and is the single definition of it. `authz.ts` gains `requireCapability(cap)`, and `requireAdmin()` is *redefined* as `requireCapability("ADMINISTER")` so all 29 existing call sites keep working untouched; narrower call sites then migrate one area at a time. The effective capability set is resolved per request from the DB read that already re-reads `role`/`isActive`, so a revoked capability dies on the next request.

**Tech Stack:** Next.js 16 (App Router, Server Actions), Prisma 7 + `@prisma/adapter-pg`, PostgreSQL 16, Zod, TypeScript 5, Vitest.

## Global Constraints

- **Nine capabilities, exactly these names:** `VIEW_INVENTORY`, `VIEW_ALL_RECEIPTS`, `CREATE_RECEIPTS`, `EDIT_ITEM_HOLDER`, `MANAGE_ITEMS`, `MANAGE_QUEUE`, `PROCESS_RETURNS`, `VIEW_ANALYTICS`, `ADMINISTER`.
- **Role baselines, exactly:** `VIEWER` → `VIEW_INVENTORY`. `USER` → `VIEW_INVENTORY`, `VIEW_ALL_RECEIPTS`, `CREATE_RECEIPTS`, `EDIT_ITEM_HOLDER`. `ADMIN` → all nine.
- **Grants are additive only.** There is no negative grant. Never add one.
- **No behavior change for existing accounts.** `USER` and `ADMIN` baselines reproduce today's rights exactly. If a step changes what an existing account can do, the step is wrong.
- **`capabilities.ts` must not import Prisma at runtime** — type-only imports (`import type`) only. It is a pure leaf module in the `readiness.ts` / `recipient-search.ts` tradition, unit-tested without a database.
- **One definition of the mapping.** Do not write a second copy in SQL, in a component, or in a test helper.
- **`prisma migrate dev` cannot run in this shell** (it is interactive). Author migration SQL with `migrate diff` and apply with `migrate deploy`. See Task 1.
- **Run `npm test` alone.** Two agents running the suite concurrently truncate each other's test database, which presents as unrelated flaky failures.
- **CI does not run tests** — the required checks are `Semgrep SAST` and `Build (next build)` only. Run `npm test` yourself before opening the PR.
- **Docs ship in the same commit as the code that changes them** (CLAUDE.md, non-negotiable). Task 9 covers this and is not optional.

## Reference

Spec: `docs/superpowers/specs/2026-08-08-capability-permissions-and-self-registration-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `prisma/schema.prisma` *(modify)* | `Capability` enum, `VIEWER` role value, `UserCapability` model, two `User` relations. |
| `prisma/migrations/20260808120000_capability_foundation/migration.sql` *(create)* | The DDL. |
| `src/modules/users/capabilities.ts` *(create)* | **Pure.** Role→capability baselines, effective-set union, risk and requestability classification. No DB. |
| `src/modules/users/capabilities.test.ts` *(create)* | Unit tests for the above. No DB. |
| `src/lib/authz.ts` *(modify)* | `requireCapability`; `requireAdmin` redefined; `SessionUser.capabilities`; `defaultGetSession` resolves the effective set. |
| `src/lib/authz.test.ts` *(modify)* | Coverage for `requireCapability` and the redefined `requireAdmin`. |
| `src/lib/session.ts` *(modify)* | `getCurrentUser` returns the effective set for UI gating. |
| `src/app/admin/actions/{items,categories,units}.ts`, `src/app/admin/items/**` *(modify)* | `MANAGE_ITEMS`. |
| `src/app/admin/actions/{queue,readiness}.ts`, `src/app/admin/queue/page.tsx`, `src/components/{MarkReadyButton,ReadinessControls}.tsx` *(modify)* | `MANAGE_QUEUE`. |
| `src/app/actions/returns.ts`, `src/app/receipts/[receiptNumber]/return/page.tsx` *(modify)* | `PROCESS_RETURNS`. |
| `src/app/admin/analytics/page.tsx` *(modify)* | `VIEW_ANALYTICS`. |
| `src/app/actions/items.ts` *(modify)* | Schema chosen by capability, not role. |
| `CLAUDE.md`, `docs/SECURITY.md`, `.claude/rules/backend-constraints.md`, `CHANGELOG.md` *(modify)* | Documentation. |

**Deliberately unchanged in this PR:** `src/proxy.ts` (never the authz boundary), the `Role` enum's existing values, and every UI surface. No user-visible change ships in PR 1.

---

## Task 1: Schema and migration

**Files:**
- Modify: `prisma/schema.prisma:9-12` (the `Role` enum) and the `User` model
- Create: `prisma/migrations/20260808120000_capability_foundation/migration.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: the Prisma types `Capability` and the `VIEWER` member of `Role`, plus `prisma.userCapability`. Every later task imports `Capability` from `@prisma/client`.

- [ ] **Step 1: Add the enums and model to the schema**

In `prisma/schema.prisma`, replace the `Role` enum and add the new enum and model:

```prisma
enum Role {
  ADMIN
  USER
  VIEWER
}

// The unit of authorization. A role supplies a BASELINE set (see
// src/modules/users/capabilities.ts, which is the single definition of that
// mapping); UserCapability rows ADD to it. There is deliberately no negative
// grant — a subtractive model makes the effective set depend on the order two
// tables are read in, and the wrong answer to "does a deny beat a grant?" is a
// privilege bug. To reduce an account below its baseline, change its role.
enum Capability {
  VIEW_INVENTORY
  VIEW_ALL_RECEIPTS
  CREATE_RECEIPTS
  EDIT_ITEM_HOLDER
  MANAGE_ITEMS
  MANAGE_QUEUE
  PROCESS_RETURNS
  VIEW_ANALYTICS
  ADMINISTER
}

// One additive grant of one capability to one user. `grantedById` is the admin
// who approved it and is SET NULL rather than cascaded: deleting the approver's
// account must not silently revoke everyone they ever granted.
model UserCapability {
  id          String     @id @default(cuid())
  user        User       @relation("UserCapabilities", fields: [userId], references: [id], onDelete: Cascade)
  userId      String
  capability  Capability
  grantedBy   User?      @relation("GrantedCapabilities", fields: [grantedById], references: [id], onDelete: SetNull)
  grantedById String?
  grantedAt   DateTime   @default(now())

  @@unique([userId, capability])
  @@index([userId])
}
```

Then add both relations to the `User` model, alongside the existing relation block:

```prisma
  capabilities        UserCapability[]      @relation("UserCapabilities")
  capabilitiesGranted UserCapability[]      @relation("GrantedCapabilities")
```

- [ ] **Step 2: Write the migration SQL by hand**

Create `prisma/migrations/20260808120000_capability_foundation/migration.sql`:

```sql
-- AlterEnum
-- NOTE: 'VIEWER' is added here but deliberately NOT referenced anywhere else in
-- this migration. Postgres forbids using a new enum value in the same
-- transaction that added it, and Prisma runs each migration in one transaction.
ALTER TYPE "Role" ADD VALUE 'VIEWER';

-- CreateEnum
CREATE TYPE "Capability" AS ENUM (
  'VIEW_INVENTORY',
  'VIEW_ALL_RECEIPTS',
  'CREATE_RECEIPTS',
  'EDIT_ITEM_HOLDER',
  'MANAGE_ITEMS',
  'MANAGE_QUEUE',
  'PROCESS_RETURNS',
  'VIEW_ANALYTICS',
  'ADMINISTER'
);

-- CreateTable
CREATE TABLE "UserCapability" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "capability" "Capability" NOT NULL,
    "grantedById" TEXT,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserCapability_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserCapability_userId_capability_key" ON "UserCapability"("userId", "capability");

-- CreateIndex
CREATE INDEX "UserCapability_userId_idx" ON "UserCapability"("userId");

-- AddForeignKey
ALTER TABLE "UserCapability" ADD CONSTRAINT "UserCapability_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserCapability" ADD CONSTRAINT "UserCapability_grantedById_fkey"
  FOREIGN KEY ("grantedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

**No backfill row is written.** Existing `USER` and `ADMIN` accounts get their rights from
the role baseline, not from grant rows. Writing grants here would be a second, drifting
copy of the mapping.

- [ ] **Step 3: Verify the hand-written SQL matches the schema**

Prisma can tell you whether your DDL and your schema agree. Run:

```bash
npx prisma migrate diff --from-config-datasource prisma/schema.prisma --to-schema prisma/schema.prisma --script
```

Expected: an empty diff (or only statements you already wrote) once the migration is applied
in Step 4. If it prints DDL you did **not** write, your `migration.sql` is incomplete — add
the missing statements rather than editing the schema to match.

> If those flag names are rejected, check `npx prisma migrate diff --help`. Prisma 7 removed
> `--from-schema-datasource` and `--to-schema-datamodel`; do not substitute them back.

- [ ] **Step 4: Apply to the local dev database**

```bash
npx prisma migrate deploy
npx prisma generate
```

Expected: `1 migration applied`, then a successful client generation.

- [ ] **Step 5: Verify the generated client carries the new types**

```bash
npx tsc --noEmit
```

Expected: PASS. Then confirm the enum actually generated:

```bash
node -e "const {Capability,Role}=require('@prisma/client');console.log(Object.keys(Capability).length, Object.keys(Role))"
```

Expected: `9 [ 'ADMIN', 'USER', 'VIEWER' ]`

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260808120000_capability_foundation
git commit -m "feat(authz): add Capability enum, VIEWER role and UserCapability grants"
```

---

## Task 2: The pure capabilities module

**Files:**
- Create: `src/modules/users/capabilities.ts`
- Test: `src/modules/users/capabilities.test.ts`

**Interfaces:**
- Consumes: `Capability`, `Role` types from `@prisma/client` (Task 1), type-only.
- Produces:
  - `CAPABILITIES: readonly Capability[]` — canonical display order
  - `roleBaseline(role: Role): Capability[]`
  - `effectiveCapabilities(role: Role, grants: readonly Capability[]): Capability[]`
  - `isElevated(capability: Capability): boolean`
  - `isRequestable(capability: Capability): boolean`
  - `CAPABILITY_LABELS: Record<Capability, string>`

- [ ] **Step 1: Write the failing test**

Create `src/modules/users/capabilities.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import {
  CAPABILITIES,
  CAPABILITY_LABELS,
  effectiveCapabilities,
  isElevated,
  isRequestable,
  roleBaseline,
} from "./capabilities";

describe("roleBaseline", () => {
  test("VIEWER can only read inventory", () => {
    expect(roleBaseline("VIEWER")).toEqual(["VIEW_INVENTORY"]);
  });

  // These four ARE today's USER rights. If this test needs changing, the
  // migration is changing what existing accounts can do — which it must not.
  test("USER keeps exactly today's rights", () => {
    expect(roleBaseline("USER")).toEqual([
      "VIEW_INVENTORY",
      "VIEW_ALL_RECEIPTS",
      "CREATE_RECEIPTS",
      "EDIT_ITEM_HOLDER",
    ]);
  });

  test("ADMIN holds every capability", () => {
    expect(roleBaseline("ADMIN")).toEqual([...CAPABILITIES]);
  });
});

describe("effectiveCapabilities", () => {
  test("adds a grant to the role baseline", () => {
    expect(effectiveCapabilities("VIEWER", ["CREATE_RECEIPTS"])).toEqual([
      "VIEW_INVENTORY",
      "CREATE_RECEIPTS",
    ]);
  });

  test("de-duplicates a grant that the baseline already covers", () => {
    expect(effectiveCapabilities("USER", ["CREATE_RECEIPTS"])).toEqual(roleBaseline("USER"));
  });

  test("returns capabilities in canonical order regardless of grant order", () => {
    const a = effectiveCapabilities("VIEWER", ["ADMINISTER", "CREATE_RECEIPTS"]);
    const b = effectiveCapabilities("VIEWER", ["CREATE_RECEIPTS", "ADMINISTER"]);
    expect(a).toEqual(b);
    expect(a).toEqual(["VIEW_INVENTORY", "CREATE_RECEIPTS", "ADMINISTER"]);
  });

  test("a grant can never remove a baseline capability", () => {
    expect(effectiveCapabilities("ADMIN", [])).toEqual([...CAPABILITIES]);
  });

  test("does not mutate its arguments", () => {
    const grants: ["CREATE_RECEIPTS"] = ["CREATE_RECEIPTS"];
    effectiveCapabilities("VIEWER", grants);
    expect(grants).toEqual(["CREATE_RECEIPTS"]);
  });
});

describe("classification", () => {
  test("ADMINISTER is the only elevated capability", () => {
    expect(CAPABILITIES.filter(isElevated)).toEqual(["ADMINISTER"]);
  });

  test("VIEW_INVENTORY is not requestable because everyone has it", () => {
    expect(isRequestable("VIEW_INVENTORY")).toBe(false);
  });

  test("ADMINISTER is requestable, elevated but not forbidden", () => {
    expect(isRequestable("ADMINISTER")).toBe(true);
  });

  test("every capability has a human label", () => {
    for (const c of CAPABILITIES) {
      expect(CAPABILITY_LABELS[c]).toBeTruthy();
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run capabilities.test`
Expected: FAIL — `Failed to resolve import "./capabilities"`.

> The Vitest pattern is a **filename** filter, not a directory. `capabilities.test` matches
> this one file, which is what you want here.

- [ ] **Step 3: Write the implementation**

Create `src/modules/users/capabilities.ts`:

```ts
// THE definition of what each role can do, and how a grant adds to it.
//
// Pure on purpose: `import type` is erased at compile time, so this module
// pulls in no Prisma client and can be unit-tested without a database — the
// same reason readiness.ts and recipient-search.ts are split out. Do not add a
// runtime import here.
//
// This is the ONLY place the role -> capability mapping is written. Do not
// restate it in SQL, in a component, or in a test helper: a second copy is a
// second answer to "what can this person do", and they will disagree.
import type { Capability, Role } from "@prisma/client";

/** Canonical order. Every list rendered to a user, and every array this module
 *  returns, is sorted by this — so two equal capability sets are also equal
 *  arrays, and a UI list never reshuffles between renders. */
export const CAPABILITIES = [
  "VIEW_INVENTORY",
  "VIEW_ALL_RECEIPTS",
  "CREATE_RECEIPTS",
  "EDIT_ITEM_HOLDER",
  "MANAGE_ITEMS",
  "MANAGE_QUEUE",
  "PROCESS_RETURNS",
  "VIEW_ANALYTICS",
  "ADMINISTER",
] as const satisfies readonly Capability[];

export const CAPABILITY_LABELS: Record<Capability, string> = {
  VIEW_INVENTORY: "View inventory",
  VIEW_ALL_RECEIPTS: "View all hand receipts",
  CREATE_RECEIPTS: "Create hand receipts",
  EDIT_ITEM_HOLDER: "Edit an item's holder and position",
  MANAGE_ITEMS: "Manage items, categories and units",
  MANAGE_QUEUE: "Manage the service queue",
  PROCESS_RETURNS: "Process returns",
  VIEW_ANALYTICS: "View analytics",
  ADMINISTER: "Administer the application",
};

/** Capabilities that hand over administrative control and are shown in the
 *  danger treatment wherever they appear. Drives the red UI in one place so the
 *  request form and the approval queue cannot disagree. */
const ELEVATED: readonly Capability[] = ["ADMINISTER"];

/** Held by every account, so asking for it is meaningless. */
const UNIVERSAL: Capability = "VIEW_INVENTORY";

// USER is exactly today's rights: read the shared property book, look at any
// receipt (they are public anyway), file a receipt, and correct an item's
// holder/position. Widening or narrowing this changes what live accounts can
// do — which the capability migration must not.
const BASELINES: Record<Role, readonly Capability[]> = {
  VIEWER: [UNIVERSAL],
  USER: [UNIVERSAL, "VIEW_ALL_RECEIPTS", "CREATE_RECEIPTS", "EDIT_ITEM_HOLDER"],
  ADMIN: CAPABILITIES,
};

function inCanonicalOrder(set: ReadonlySet<Capability>): Capability[] {
  return CAPABILITIES.filter((c) => set.has(c));
}

/** The capabilities a role confers with no grants at all. */
export function roleBaseline(role: Role): Capability[] {
  return inCanonicalOrder(new Set(BASELINES[role]));
}

/** What a user can actually do: the role baseline UNION their grants.
 *
 *  Union, never difference. A grant only ever adds — see the note on the
 *  Capability enum in schema.prisma for why there is no negative grant. */
export function effectiveCapabilities(
  role: Role,
  grants: readonly Capability[],
): Capability[] {
  return inCanonicalOrder(new Set([...BASELINES[role], ...grants]));
}

export function isElevated(capability: Capability): boolean {
  return ELEVATED.includes(capability);
}

/** Whether a user may ask for this capability. Everything except the one
 *  everybody already holds — ADMINISTER included, since it is requestable but
 *  flagged (see isElevated). */
export function isRequestable(capability: Capability): boolean {
  return capability !== UNIVERSAL;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run capabilities.test`
Expected: PASS — 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/modules/users/capabilities.ts src/modules/users/capabilities.test.ts
git commit -m "feat(authz): add the pure role-to-capability mapping module"
```

---

## Task 3: `requireCapability` and the redefined `requireAdmin`

**Files:**
- Modify: `src/lib/authz.ts:4` (`SessionUser`), `:27-38` (`defaultGetSession`), `:48-54` (`requireAdmin`)
- Test: `src/lib/authz.test.ts`

**Interfaces:**
- Consumes: `effectiveCapabilities` from Task 2; `Capability` type from Task 1.
- Produces:
  - `SessionUser` now carries `capabilities: Capability[]` — the **already-resolved effective set**, not raw grants.
  - `requireCapability(capability: Capability, getSession?): Promise<SessionUser>`
  - `requireAdmin(getSession?)` unchanged in signature, now delegating to `requireCapability("ADMINISTER", …)`.

- [ ] **Step 1: Write the failing test**

Replace `src/lib/authz.test.ts` entirely:

```ts
import { expect, test } from "vitest";
import { requireUser, requireAdmin, requireCapability, AuthError } from "./authz";
import { roleBaseline } from "@/modules/users/capabilities";

// `capabilities` is the RESOLVED effective set, exactly as defaultGetSession
// builds it — these fixtures go through roleBaseline so they cannot drift from
// the real mapping.
const admin = {
  id: "1", role: "ADMIN", name: "A", email: "a@x.co",
  capabilities: roleBaseline("ADMIN"),
} as const;

const user = {
  id: "2", role: "USER", name: "U", email: "u@x.co",
  capabilities: roleBaseline("USER"),
} as const;

const viewer = {
  id: "3", role: "VIEWER", name: "V", email: "v@x.co",
  capabilities: roleBaseline("VIEWER"),
} as const;

// A USER who was GRANTED one extra capability. The point of the whole model:
// their role is unchanged, but the grant admits them.
const grantedUser = {
  id: "4", role: "USER", name: "G", email: "g@x.co",
  capabilities: [...roleBaseline("USER"), "PROCESS_RETURNS"],
} as const;

test("requireUser returns the user when a session exists", async () => {
  const getSession = async () => ({ user });
  await expect(requireUser(getSession)).resolves.toEqual(user);
});

test("requireUser throws UNAUTHENTICATED when no session", async () => {
  const getSession = async () => null;
  await expect(requireUser(getSession)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
});

test("requireAdmin throws FORBIDDEN for a standard user", async () => {
  const getSession = async () => ({ user });
  await expect(requireAdmin(getSession)).rejects.toMatchObject({ code: "FORBIDDEN" });
});

test("requireAdmin returns the user for an admin", async () => {
  const getSession = async () => ({ user: admin });
  await expect(requireAdmin(getSession)).resolves.toEqual(admin);
});

test("requireCapability admits a user holding it via their role baseline", async () => {
  const getSession = async () => ({ user });
  await expect(requireCapability("CREATE_RECEIPTS", getSession)).resolves.toEqual(user);
});

test("requireCapability admits a user holding it via a grant", async () => {
  const getSession = async () => ({ user: grantedUser });
  await expect(requireCapability("PROCESS_RETURNS", getSession)).resolves.toEqual(grantedUser);
});

test("requireCapability refuses a user who holds neither", async () => {
  const getSession = async () => ({ user });
  await expect(requireCapability("MANAGE_ITEMS", getSession)).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
});

test("requireCapability refuses a VIEWER everything but reading inventory", async () => {
  const getSession = async () => ({ user: viewer });
  await expect(requireCapability("VIEW_INVENTORY", getSession)).resolves.toEqual(viewer);
  await expect(requireCapability("CREATE_RECEIPTS", getSession)).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  await expect(requireCapability("EDIT_ITEM_HOLDER", getSession)).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
});

test("requireCapability throws UNAUTHENTICATED before FORBIDDEN when there is no session", async () => {
  const getSession = async () => null;
  await expect(requireCapability("VIEW_INVENTORY", getSession)).rejects.toMatchObject({
    code: "UNAUTHENTICATED",
  });
});

// The hinge of the migration: a granted ADMINISTER must satisfy every existing
// requireAdmin() call site without any of them being edited.
test("a granted ADMINISTER satisfies requireAdmin without a role change", async () => {
  const grantedAdmin = {
    id: "5", role: "USER", name: "P", email: "p@x.co",
    capabilities: [...roleBaseline("USER"), "ADMINISTER"],
  } as const;
  const getSession = async () => ({ user: grantedAdmin });
  await expect(requireAdmin(getSession)).resolves.toEqual(grantedAdmin);
});

test("AuthError is thrown, not a bare Error", async () => {
  const getSession = async () => ({ user });
  await expect(requireCapability("ADMINISTER", getSession)).rejects.toBeInstanceOf(AuthError);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run authz.test`
Expected: FAIL — `requireCapability is not a function`, plus type errors on the `capabilities` fixtures.

- [ ] **Step 3: Write the implementation**

In `src/lib/authz.ts`, change the type import, `SessionUser`, `defaultGetSession`, and
`requireAdmin`, and add `requireCapability`:

```ts
import "server-only"; // authorization logic is server-only
import type { Capability, Role } from "@prisma/client";
import { effectiveCapabilities } from "@/modules/users/capabilities";

// `capabilities` is the RESOLVED effective set (role baseline ∪ grants), not the
// raw grant rows. Resolving it in exactly one place — defaultGetSession, below —
// means no call site can forget to apply the baseline and accidentally refuse an
// admin.
export type SessionUser = {
  id: string;
  role: Role;
  name: string;
  email: string;
  capabilities: Capability[];
};
```

Replace the body of `defaultGetSession`'s DB read (keeping every existing comment above it,
which still describes why this re-read exists):

```ts
const defaultGetSession: GetSession = async () => {
  const { auth } = await import("@/auth");
  const session = await auth();
  if (!session?.user) return null;
  const { default: prisma } = await import("@/lib/prisma");
  const fresh = await prisma.user.findUnique({
    where: { id: session.user.id },
    // Capabilities ride along on the read that ALREADY re-reads role/isActive —
    // one query, no N+1, and a revoked grant dies on the next request exactly
    // as a demotion does. The JWT deliberately never carries capabilities: a
    // token minted before a grant would be stale, and per-request freshness is
    // the entire justification for the 30-day session window.
    select: {
      role: true,
      isActive: true,
      capabilities: { select: { capability: true } },
    },
  });
  if (!fresh || !fresh.isActive) return null;
  return {
    user: {
      ...session.user,
      role: fresh.role,
      capabilities: effectiveCapabilities(
        fresh.role,
        fresh.capabilities.map((c) => c.capability),
      ),
    },
  };
};
```

Then replace `requireAdmin` and add `requireCapability`:

```ts
/**
 * The authorization primitive. Gate on a CAPABILITY, never on a role directly
 * and never on "the caller happens to own this row" — inventory, receipts and
 * the queue are shared org-wide.
 */
export async function requireCapability(
  capability: Capability,
  getSession: GetSession = defaultGetSession,
): Promise<SessionUser> {
  const user = await requireUser(getSession);
  if (!user.capabilities.includes(capability)) throw new AuthError("FORBIDDEN");
  return user;
}

/**
 * Kept as the gate for genuinely administrative surfaces — users, audit,
 * contacts, named signatures, the access PIN, receipt timers, seal verification.
 *
 * It is now a THIN ALIAS for the ADMINISTER capability rather than a role check.
 * That is what let the capability model land without editing 29 call sites at
 * once, and it means a granted ADMINISTER works everywhere immediately. Call
 * sites that want something narrower call requireCapability directly.
 */
export async function requireAdmin(
  getSession: GetSession = defaultGetSession,
): Promise<SessionUser> {
  return requireCapability("ADMINISTER", getSession);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run authz.test`
Expected: PASS — 12 tests.

- [ ] **Step 5: Typecheck the whole app**

Run: `npx tsc --noEmit`
Expected: PASS. If anything constructs a `SessionUser` literal without `capabilities`, fix it
by resolving the set through `effectiveCapabilities` — never by making the field optional.

- [ ] **Step 6: Commit**

```bash
git add src/lib/authz.ts src/lib/authz.test.ts
git commit -m "feat(authz): add requireCapability and redefine requireAdmin as ADMINISTER"
```

---

## Task 4: Capabilities on the UI session read

**Files:**
- Modify: `src/lib/session.ts:14-22`

**Interfaces:**
- Consumes: `effectiveCapabilities` (Task 2).
- Produces: `getCurrentUser()` resolves to `{ id, name, email, role, isActive, capabilities: Capability[] } | null`. Later PRs gate nav and page chrome on this.

- [ ] **Step 1: Update `getCurrentUser`**

```ts
export const getCurrentUser = cache(async () => {
  const session = await getSession();
  const id = session?.user?.id;
  if (!id) return null;
  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      isActive: true,
      capabilities: { select: { capability: true } },
    },
  });
  if (!user) return null;
  // Resolved through the SAME pure function requireCapability's session read
  // uses, so what the nav shows and what the server actually permits cannot
  // drift. This is for rendering decisions only — it is NOT an authz boundary,
  // which stays per-route in requireCapability.
  const { capabilities, ...rest } = user;
  return {
    ...rest,
    capabilities: effectiveCapabilities(
      user.role,
      capabilities.map((c) => c.capability),
    ),
  };
});
```

Add the import at the top: `import { effectiveCapabilities } from "@/modules/users/capabilities";`

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS. `SiteHeader` reads `user.role === "ADMIN"` and still compiles; leave it alone
— nav changes belong to PR 3.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: PASS. Run it alone — concurrent runs truncate the shared test database.

- [ ] **Step 4: Commit**

```bash
git add src/lib/session.ts
git commit -m "feat(authz): resolve effective capabilities on the UI session read"
```

---

## Task 5: Migrate the item-management call sites

**Files:**
- Modify: `src/app/admin/actions/items.ts` (9 sites), `src/app/admin/actions/categories.ts` (3), `src/app/admin/actions/units.ts` (5), `src/app/admin/items/new/page.tsx`, `src/app/admin/items/import/page.tsx`, `src/app/admin/items/[itemId]/edit/page.tsx`, `src/app/admin/categories/page.tsx`, `src/app/admin/units/page.tsx`, `src/app/admin/items/qr-sheet/pdf/route.ts`, `src/components/DeleteItemButton.tsx`

**Interfaces:**
- Consumes: `requireCapability` (Task 3).
- Produces: no new exports. Behavior is unchanged for every existing account, because `ADMIN` holds `MANAGE_ITEMS` in its baseline and `USER` never reached these surfaces.

- [ ] **Step 1: Replace the calls**

In each file, change the import and the call:

```ts
// before
import { requireAdmin } from "@/lib/authz";
await requireAdmin();

// after
import { requireCapability } from "@/lib/authz";
await requireCapability("MANAGE_ITEMS");
```

Where a file already imports other names from `@/lib/authz` (e.g. `AuthError` in the page
components), keep them: `import { requireCapability, AuthError } from "@/lib/authz";`

`DeleteItemButton.tsx` calls `requireAdmin()` inside a comment-documented re-check; convert
the call and leave the comment, adjusting the word "admin" to "the MANAGE_ITEMS capability".

- [ ] **Step 2: Confirm no `requireAdmin` remains in these files**

Run: `npx tsc --noEmit` then

```bash
grep -rn "requireAdmin" src/app/admin/actions/items.ts src/app/admin/actions/categories.ts src/app/admin/actions/units.ts src/app/admin/items src/app/admin/categories/page.tsx src/app/admin/units/page.tsx src/components/DeleteItemButton.tsx
```

Expected: no matches.

- [ ] **Step 3: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/app/admin src/components/DeleteItemButton.tsx
git commit -m "refactor(authz): gate item, category and unit management on MANAGE_ITEMS"
```

---

## Task 6: Migrate the service-queue call sites

**Files:**
- Modify: `src/app/admin/actions/queue.ts` (5 sites), `src/app/admin/actions/readiness.ts` (3), `src/app/admin/queue/page.tsx`, `src/components/MarkReadyButton.tsx`, `src/components/ReadinessControls.tsx`

**Interfaces:**
- Consumes: `requireCapability` (Task 3).
- Produces: no new exports.

- [ ] **Step 1: Replace the calls**

```ts
// before
import { requireAdmin } from "@/lib/authz";
await requireAdmin();

// after
import { requireCapability } from "@/lib/authz";
await requireCapability("MANAGE_QUEUE");
```

`setItemsCategoryAction` lives in `readiness.ts` but assigns a **category**, not readiness —
gate that one on `MANAGE_ITEMS`, matching Task 5, not `MANAGE_QUEUE`.

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit` then

```bash
grep -rn "requireAdmin\|requireCapability" src/app/admin/actions/queue.ts src/app/admin/actions/readiness.ts src/components/MarkReadyButton.tsx src/components/ReadinessControls.tsx
```

Expected: only `requireCapability` lines, with `setItemsCategoryAction` showing `MANAGE_ITEMS`.

- [ ] **Step 3: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/app/admin/actions/queue.ts src/app/admin/actions/readiness.ts src/app/admin/queue/page.tsx src/components/MarkReadyButton.tsx src/components/ReadinessControls.tsx
git commit -m "refactor(authz): gate the service queue and readiness on MANAGE_QUEUE"
```

---

## Task 7: Migrate returns and analytics

**Files:**
- Modify: `src/app/actions/returns.ts`, `src/app/receipts/[receiptNumber]/return/page.tsx`, `src/app/admin/analytics/page.tsx` (2 sites)

**Interfaces:**
- Consumes: `requireCapability` (Task 3).
- Produces: no new exports.

- [ ] **Step 1: Replace the calls**

In `returns.ts` and the return page:

```ts
import { requireCapability } from "@/lib/authz";
await requireCapability("PROCESS_RETURNS");
```

In `analytics/page.tsx`:

```ts
import { requireCapability } from "@/lib/authz";
await requireCapability("VIEW_ANALYTICS");
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Run the tests**

Run: `npm test`
Expected: PASS — `returns.test.ts` exercises this action, so a wrong capability name shows up
here rather than in production.

- [ ] **Step 4: Commit**

```bash
git add src/app/actions/returns.ts src/app/receipts src/app/admin/analytics/page.tsx
git commit -m "refactor(authz): gate returns on PROCESS_RETURNS and analytics on VIEW_ANALYTICS"
```

---

## Task 8: Pick the item-edit schema by capability

**Files:**
- Modify: `src/app/actions/items.ts:10-22`
- Test: `src/app/actions/items.test.ts`

**Interfaces:**
- Consumes: `requireCapability` (Task 3).
- Produces: no new exports. `updateItemDetailsAction` now requires `EDIT_ITEM_HOLDER` and widens to the eight-field schema on `MANAGE_ITEMS`.

This is the one task that changes a gate's *shape* rather than its name. Today the action
calls bare `requireUser()` and switches schema on `user.role === "ADMIN"`. A `VIEWER` must be
refused outright, and the wide schema must follow the capability rather than the role — so a
granted `MANAGE_ITEMS` gets the full field set without being made an admin.

- [ ] **Step 1: Write the failing test**

Append to `src/app/actions/items.test.ts` — match the file's existing mocking style rather
than introducing a new one; read the top of the file first:

```ts
test("a holder-only caller cannot write admin-only item fields", async () => {
  // A USER holds EDIT_ITEM_HOLDER but not MANAGE_ITEMS, so the narrow schema
  // applies and z.object() strips deviceName even though the POST carries it.
  const form = new FormData();
  form.set("id", existingItemId);
  form.set("currentPosition", "Supply");
  form.set("deviceName", "SMUGGLED");

  await updateItemDetailsAction(undefined, form);

  const after = await prisma.item.findUniqueOrThrow({ where: { id: existingItemId } });
  expect(after.currentPosition).toBe("Supply");
  expect(after.deviceName).not.toBe("SMUGGLED");
});
```

- [ ] **Step 2: Run it to verify it fails or passes as expected**

Run: `npx vitest run items.test`
Expected: this specific assertion PASSES already (the role check does this today). It is a
**regression guard** — it must keep passing after Step 3, which is the point. If it fails
now, stop: the existing protection is broken and that is a separate bug.

- [ ] **Step 3: Change the gate**

Replace the comment block and the first lines of `updateItemDetailsAction`:

```ts
// Inventory is shared org-wide, so there is deliberately no per-user ownership
// filter — access is gated on CAPABILITY. MANAGE_ITEMS may edit all eight
// editable item fields; EDIT_ITEM_HOLDER may change only the current holder
// email and current position. The capability picks the schema, and z.object()
// strips the rest, so a holder-only caller's crafted POST cannot alter
// deviceName/homeUnit/deviceUIC/notes/deviceCategory/storageLocation even
// though the form hides those inputs.
//
// Requiring EDIT_ITEM_HOLDER (rather than any session) is what keeps a VIEWER
// out: read access to the property book does not carry write access to it.
// Every change is recorded as an ItemEdit by updateItemFields.
export async function updateItemDetailsAction(_prev: unknown, formData: FormData) {
  const user = await requireCapability("EDIT_ITEM_HOLDER");
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return { error: "Missing item." };

  const schema = user.capabilities.includes("MANAGE_ITEMS")
    ? itemDetailsSchema
    : userItemDetailsSchema;
```

Change the import on line 3 to `import { requireCapability } from "@/lib/authz";`

- [ ] **Step 4: Run the tests**

Run: `npx vitest run items.test`
Expected: PASS, including the regression guard from Step 1.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/actions/items.ts src/app/actions/items.test.ts
git commit -m "refactor(authz): pick the item-edit schema by capability, refuse viewers"
```

---

## Task 9: Documentation

**Files:**
- Modify: `CLAUDE.md` (§1 Authorization), `docs/SECURITY.md`, `.claude/rules/backend-constraints.md`, `CHANGELOG.md`

Per CLAUDE.md this is part of the change, not a follow-up. The rule this PR contradicts is
stated in CLAUDE.md in the imperative, so leaving it would actively mislead the next reader.

- [ ] **Step 1: Rewrite the CLAUDE.md authorization rules**

In §1, replace the opening bullet:

```markdown
- Authorization is **capability-based** (`Capability`, nine values); inventory, receipts, and
  the queue are **shared org-wide**. Do NOT add `session.user.id` ownership filters to
  item/receipt/queue queries — gate on capability.
- **A role is a BASELINE capability set, not a check.** `VIEWER` → `VIEW_INVENTORY`. `USER` →
  that plus `VIEW_ALL_RECEIPTS`, `CREATE_RECEIPTS`, `EDIT_ITEM_HOLDER`. `ADMIN` → all nine.
  `UserCapability` rows ADD to the baseline. **There is no negative grant** — a subtractive
  model makes the effective set depend on the order two tables are read in. To reduce an
  account below its baseline, change its role.
- `src/modules/users/capabilities.ts` is the **single definition** of that mapping. It is
  pure (no Prisma runtime import) so it can be unit-tested directly. Never write a second
  copy in SQL, in a component, or in a test helper.
- Every Server Action and Route Handler MUST start with `requireUser()`, `requireCapability()`
  or `requireAdmin()` from `@/lib/authz` — never bare `auth()`. These re-read `role`,
  `isActive` **and the capability grants** from the DB per request, so demotion,
  deactivation and revocation take effect immediately.
- **`requireAdmin()` is now a thin alias for `requireCapability("ADMINISTER")`**, kept for the
  genuinely administrative surfaces: users, audit, contact book, named signatures, the access
  PIN, receipt timers, seal verification. Anything narrower calls `requireCapability`
  directly — `MANAGE_ITEMS`, `MANAGE_QUEUE`, `PROCESS_RETURNS`, `VIEW_ANALYTICS`.
```

Then update the `updateItemDetailsAction` sentence, which currently says the schema is picked
by role: it is picked by `MANAGE_ITEMS` vs `EDIT_ITEM_HOLDER`, and a caller with neither is
refused.

Leave the "no public self-registration" rule alone — PR 2 changes it, and editing it now
would describe code that does not exist yet.

- [ ] **Step 2: Update `docs/SECURITY.md`**

Add an entry for capability-based authorization under the access-control section: what the
nine capabilities are, that roles are baselines, that grants are additive-only, and that the
effective set is re-read per request from the same query that re-reads `role`/`isActive`.
Bump *Last reviewed* to 2026-08-08.

Do **not** add the PIN-bypass or receipt-scoping gaps yet — those describe PR 2 behavior.

- [ ] **Step 3: Update `.claude/rules/backend-constraints.md`**

Add the capability model and the additive-only rule, plus the note that
`capabilities.ts` is the single definition. This file loads automatically for anyone opening
`src/modules/**`, `src/app/admin/**` or `src/app/actions/**` — which is every file this PR
touched.

- [ ] **Step 4: Add the CHANGELOG entry**

Under a `## 2026-08-08` heading (newest section at the top), following Keep a Changelog:

```markdown
### Added
- Capability-based authorization. Access is now decided by one of nine capabilities rather
  than by the `ADMIN`/`USER` role directly. A role supplies a baseline set and an
  administrator can grant an individual capability on top of it, so someone can be given
  just the service queue — or just returns — without being made an administrator.
- A `VIEWER` role that can read the property book and nothing else. Nothing creates one yet.

### Changed
- Administrative surfaces are now gated on the specific capability they need rather than on
  "is an admin": items, categories and units on `MANAGE_ITEMS`; the service queue and
  readiness on `MANAGE_QUEUE`; returns on `PROCESS_RETURNS`; analytics on `VIEW_ANALYTICS`.
  Existing administrator and user accounts can do exactly what they could before.

### Notes
- Migration `20260808120000_capability_foundation` adds the `Capability` enum, the `VIEWER`
  role value and the `UserCapability` table. No data backfill is required — existing accounts
  draw their access from the role baseline. **Apply it to Supabase before merging**, per
  migrate-before-push.
```

- [ ] **Step 5: Verify the docs match the code**

```bash
grep -n "role-based" CLAUDE.md
```

Expected: no match in §1 (the phrase is replaced). Then re-read your §1 edit against
`src/modules/users/capabilities.ts` and confirm the three baselines listed there are
character-for-character the ones in `BASELINES`.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md docs/SECURITY.md .claude/rules/backend-constraints.md CHANGELOG.md
git commit -m "docs: capability-based authorization replaces role checks"
```

---

## Task 10: Verify and open the PR

- [ ] **Step 1: Full suite, alone**

Run: `npm test`
Expected: PASS, ~118 files. Nothing else may be running the suite.

- [ ] **Step 2: Lint and build**

Run: `npm run lint && npm run build`
Expected: both PASS. `build` is one of the two required CI checks, so a failure here is a
failure on the PR.

- [ ] **Step 3: Prove the gate actually holds at runtime**

Start the dev server, sign in as the local admin, and confirm `/admin/queue`, `/admin/units`,
`/admin/analytics` and an item edit all still work. Then, in a psql session against the dev
database, demote yourself to `VIEWER` and confirm those same pages refuse you:

```sql
UPDATE "User" SET role = 'VIEWER' WHERE email = '<your dev admin email>';
```

Reload without signing out — the refusal must be **immediate**, because the capability set is
re-read per request. That is the whole freshness claim; verify it rather than assuming it.
Then restore:

```sql
UPDATE "User" SET role = 'ADMIN' WHERE email = '<your dev admin email>';
```

- [ ] **Step 4: Grant a single capability and confirm it admits**

```sql
INSERT INTO "UserCapability" (id, "userId", capability, "grantedAt")
SELECT gen_random_uuid()::text, id, 'MANAGE_QUEUE', now() FROM "User" WHERE email = '<a dev USER account>';
```

Sign in as that account and confirm `/admin/queue` now loads, while `/admin/units` still
refuses. Delete the row afterwards.

- [ ] **Step 5: Apply the migration to production before merging**

Per migrate-before-push: `next build` never runs `migrate deploy`, so merged code that
selects `UserCapability` against a database without that table is a production 500. Apply the
migration to Supabase first (see the manual-apply note in `DEPLOY.md`), then merge.

- [ ] **Step 6: Open the PR**

```bash
git push -u origin feat/capability-foundation
gh pr create --title "feat(authz): capability-based authorization foundation" --body "..."
```

Required checks: `Semgrep SAST`, `Build (next build)`. Both must be green; `main` is
branch-protected and `strict` is on, so rebase if `main` moved.

---

## Self-Review Notes

**Spec coverage.** §1 capability model → Tasks 1, 2. §2 authorization layer → Tasks 3, 4, 5,
6, 7, 8. §11 documentation → Task 9. §10 sequencing → this plan is PR 1 only; §3 registration,
§4 receipt scoping, §5–7 the request workflow are PR 2 and PR 3 and are deliberately absent.

**Known deferrals, all intentional.** `SiteHeader` still reads `user.role === "ADMIN"` for nav
— it renders identically either way, and the nav rework belongs with the surfaces PR 3 adds.
`registerSchema` stays unused. No UI ships.

**Risk to watch.** Task 3 is the only place a mistake is silent rather than loud: if
`defaultGetSession` forgot to apply `effectiveCapabilities` and passed raw grants through, an
admin with no grant rows would be locked out of everything — loudly — but a *user* with a
grant would quietly gain only that grant and lose their baseline. The test
"a grant can never remove a baseline capability" in Task 2 and
"requireCapability admits a user holding it via their role baseline" in Task 3 are what catch
it. Do not weaken either.
