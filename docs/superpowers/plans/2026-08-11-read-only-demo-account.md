# Read-Only Demo Account Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `test@gmail.com` browse the real admin portal while every database write it attempts is refused with a message.

**Architecture:** An env-var allowlist (`READ_ONLY_DEMO_EMAILS`) marks demo accounts. The flag is resolved once, in `defaultGetSession`, onto `SessionUser.isReadOnly`. Every mutating Server Action calls `denyReadOnly(user)` and returns its refusal. The unauthenticated password-reset path is blocked separately because it has no session to test. A banner in the admin layout makes the mode visible.

**Tech Stack:** Next.js 16 (App Router, Server Actions), TypeScript 5, Prisma 7, Vitest.

## Global Constraints

- **No negative capability grants.** `src/modules/users/capabilities.ts` is untouched by this work. Read-only is a concept *beside* the capability model, never inside it.
- **Refusal copy is exactly:** `Demo account — changes are not saved.` (em dash, one sentence). Defined once as `DEMO_REFUSAL` and never retyped.
- **`src/lib/read-only-demo.ts` must stay pure** — no Prisma, no `server-only`, no `next/*` import — so it unit-tests directly and can be imported from `auth.ts`.
- **Do not change `checkCredentials`.** Email verification is fixed by stamping the DB row, not by a code bypass. The password-before-verification order in `src/modules/auth/credentials.ts:52-56` is load-bearing.
- **Never `console.log` the demo email list** or any user email — CLAUDE.md §4a.
- Tests live beside their subject (`x.ts` → `x.test.ts`). Run with `npx vitest run <filename-pattern>`.
- Per `parallel-agents-share-one-test-db`: if another session holds the test DB, do not fight it — push and let CI run the suite.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/read-only-demo.ts` | **Create.** Pure: parse the env var, answer `isReadOnlyDemo(email)`. |
| `src/lib/read-only-demo.test.ts` | **Create.** Unit tests for the parser. |
| `src/lib/authz.ts` | **Modify.** `SessionUser.isReadOnly`, `DEMO_REFUSAL`, `denyReadOnly()`. |
| `src/lib/authz.test.ts` | **Modify.** Cover `denyReadOnly`. |
| `src/app/actions/auth.ts` | **Modify.** Block reset-token minting for demo emails. |
| `src/app/actions/*.ts` (7 files) | **Modify.** Add the guard to 13 mutating actions. |
| `src/app/admin/actions/*.ts` (11 files) | **Modify.** Add the guard to 30 mutating actions. |
| `src/app/actions/read-only-coverage.test.ts` | **Create.** Fails if a mutating action lacks the guard. |
| `src/components/ReadOnlyBanner.tsx` | **Create.** The banner. |
| `src/app/admin/layout.tsx` | **Modify.** Render the banner. |
| `.env.example`, `CHANGELOG.md`, `docs/SECURITY.md`, `CLAUDE.md` | **Modify.** Docs, same commit as the code. |

---

## Task 1: The `isReadOnlyDemo` predicate

**Files:**
- Create: `src/lib/read-only-demo.ts`
- Test: `src/lib/read-only-demo.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `isReadOnlyDemo(email: string | null | undefined): boolean` — reads `process.env.READ_ONLY_DEMO_EMAILS` on **every call** (not at module load, so tests can set it per case).

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/read-only-demo.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { isReadOnlyDemo } from "./read-only-demo";

const ORIGINAL = process.env.READ_ONLY_DEMO_EMAILS;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.READ_ONLY_DEMO_EMAILS;
  else process.env.READ_ONLY_DEMO_EMAILS = ORIGINAL;
});

describe("isReadOnlyDemo", () => {
  it("matches a listed address", () => {
    process.env.READ_ONLY_DEMO_EMAILS = "test@gmail.com";
    expect(isReadOnlyDemo("test@gmail.com")).toBe(true);
  });

  it("is case-insensitive on both sides", () => {
    process.env.READ_ONLY_DEMO_EMAILS = "Test@Gmail.COM";
    expect(isReadOnlyDemo("TEST@gmail.com")).toBe(true);
  });

  it("tolerates whitespace and empty entries", () => {
    process.env.READ_ONLY_DEMO_EMAILS = " a@x.com , , b@x.com ";
    expect(isReadOnlyDemo("b@x.com")).toBe(true);
    expect(isReadOnlyDemo("a@x.com")).toBe(true);
  });

  it("does not match an unlisted address", () => {
    process.env.READ_ONLY_DEMO_EMAILS = "test@gmail.com";
    expect(isReadOnlyDemo("real@dcsim.us")).toBe(false);
  });

  // The fail-open case, pinned so it is a decision rather than an accident.
  it("returns false when the variable is unset or empty", () => {
    delete process.env.READ_ONLY_DEMO_EMAILS;
    expect(isReadOnlyDemo("test@gmail.com")).toBe(false);
    process.env.READ_ONLY_DEMO_EMAILS = "   ";
    expect(isReadOnlyDemo("test@gmail.com")).toBe(false);
  });

  it("never matches a blank or missing email", () => {
    process.env.READ_ONLY_DEMO_EMAILS = "test@gmail.com,";
    expect(isReadOnlyDemo("")).toBe(false);
    expect(isReadOnlyDemo(null)).toBe(false);
    expect(isReadOnlyDemo(undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run read-only-demo`
Expected: FAIL — `Failed to resolve import "./read-only-demo"`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/read-only-demo.ts
//
// Marks a DEMO account: one that may read the whole app but whose writes are
// refused (see denyReadOnly in src/lib/authz.ts).
//
// PURE on purpose — no Prisma, no `server-only`, no next/* import — for the same
// reason capabilities.ts and readiness.ts are: it unit-tests without a database,
// and it has to be importable from `src/app/actions/auth.ts`, which runs on the
// unauthenticated password-reset path.
//
// This is NOT part of the capability model. Capabilities are additive and have
// no negative grant, deliberately (CLAUDE.md §1); this sits beside them and
// answers a different question — "may this session write at all".
//
// IT FAILS OPEN. An unset or misspelled READ_ONLY_DEMO_EMAILS means nobody is
// read-only, so a demo account keeps whatever its ROLE grants. That tradeoff is
// recorded in docs/SECURITY.md under Known gaps; the banner in the admin layout
// is the visible tell that the variable is actually set.

/** Whether this address is configured as a read-only demo account. */
export function isReadOnlyDemo(email: string | null | undefined): boolean {
  if (!email) return false;
  const raw = process.env.READ_ONLY_DEMO_EMAILS;
  if (!raw) return false;
  const wanted = email.trim().toLowerCase();
  if (!wanted) return false;
  // Read per call rather than at module load: the value is read on a request
  // path, and a module-load snapshot would be wrong for the whole process if
  // the variable changed, and untestable per case.
  return raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .includes(wanted);
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run read-only-demo`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/read-only-demo.ts src/lib/read-only-demo.test.ts
git commit -m "feat(auth): add the read-only demo account predicate"
```

---

## Task 2: Resolve the flag onto the session, and the refusal helper

**Files:**
- Modify: `src/lib/authz.ts` (the `SessionUser` type at `:9`, `defaultGetSession` at `:38`, then append)
- Modify: `src/lib/authz.test.ts`

**Interfaces:**
- Consumes: `isReadOnlyDemo` from Task 1.
- Produces:
  - `SessionUser.isReadOnly: boolean`
  - `DEMO_REFUSAL: { readonly error: "Demo account — changes are not saved." }`
  - `denyReadOnly(user: SessionUser): typeof DEMO_REFUSAL | null`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/authz.test.ts`. Match the existing file's style of injecting a fake `getSession`; the fake user object below must include every `SessionUser` field.

```ts
import { denyReadOnly, DEMO_REFUSAL, type SessionUser } from "./authz";

describe("denyReadOnly", () => {
  const base: SessionUser = {
    id: "u1",
    role: "ADMIN",
    name: "Demo",
    email: "test@gmail.com",
    capabilities: ["VIEW_INVENTORY"],
    isReadOnly: false,
  };

  it("lets an ordinary user through", () => {
    expect(denyReadOnly(base)).toBeNull();
  });

  it("refuses a read-only user with the shared message", () => {
    expect(denyReadOnly({ ...base, isReadOnly: true })).toEqual(DEMO_REFUSAL);
  });

  it("uses the exact copy the forms render", () => {
    expect(DEMO_REFUSAL.error).toBe("Demo account — changes are not saved.");
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run authz`
Expected: FAIL — `denyReadOnly is not a function`, plus a TypeScript error on `isReadOnly` not existing on `SessionUser`.

- [ ] **Step 3: Add the field to `SessionUser`**

In `src/lib/authz.ts`, replace the `SessionUser` type (currently `:9-15`):

```ts
export type SessionUser = {
  id: string;
  role: Role;
  name: string;
  email: string;
  capabilities: Capability[];
  // Whether this session may WRITE. Resolved in defaultGetSession from the DB
  // email, never from the JWT, and re-evaluated per request like role/isActive.
  // See src/lib/read-only-demo.ts for why this is not a capability.
  isReadOnly: boolean;
};
```

- [ ] **Step 4: Resolve it in `defaultGetSession`**

Add the import at the top of `src/lib/authz.ts`, beside the `effectiveCapabilities` import:

```ts
import { isReadOnlyDemo } from "@/lib/read-only-demo";
```

Add `email: true` to the existing `select` (currently `:50-54`) and set the field on the returned user (currently `:57-66`):

```ts
    select: {
      role: true,
      isActive: true,
      email: true,
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
      // From the DB row, not the JWT: the token is signed so it cannot be
      // forged, but the DB is the value every other freshness check here uses,
      // and it rides along on a query we were already making.
      isReadOnly: isReadOnlyDemo(fresh.email),
    },
  };
```

- [ ] **Step 5: Append the refusal helper to `src/lib/authz.ts`**

```ts
/**
 * The one refusal a demo account ever sees. Shaped as `{ error }` because that
 * is what every `useActionState` form in this app renders.
 */
export const DEMO_REFUSAL = {
  error: "Demo account — changes are not saved.",
} as const;

/**
 * The WRITE gate for demo accounts. Returns null when the caller may write, or
 * the refusal object when they may not.
 *
 * Deliberately NOT a throwing `requireWrite()`: a thrown AuthError escalates to
 * the error boundary and replaces the form with a digest, where returning the
 * refusal lands the sentence in the form the user is looking at (CLAUDE.md §5).
 *
 * Call it AFTER the existing requireUser/requireCapability/requireAdmin line —
 * authorization first, then "may this session write at all":
 *
 *   const user = await requireCapability("MANAGE_ITEMS");
 *   const denied = denyReadOnly(user);
 *   if (denied) return denied;
 *
 * It cannot cover an UNAUTHENTICATED write path, because there is no session to
 * test — see the demo block in requestPasswordResetAction.
 */
export function denyReadOnly(user: SessionUser): typeof DEMO_REFUSAL | null {
  return user.isReadOnly ? DEMO_REFUSAL : null;
}
```

- [ ] **Step 6: Fix every other construction of a `SessionUser`**

`isReadOnly` is now required, so any test helper or `src/lib/session.ts` path that builds a `SessionUser` literal will fail to compile.

Run: `npx tsc --noEmit`
Add `isReadOnly: false` to each reported literal. Do **not** make the field optional to avoid this — an optional flag defaults to "may write" in a type that is checked at every write site, and a missed call site should be a compile error rather than a silent write grant.

- [ ] **Step 7: Run the tests and typecheck**

Run: `npx vitest run authz` → Expected: PASS
Run: `npx tsc --noEmit` → Expected: no errors

- [ ] **Step 8: Commit**

```bash
git add src/lib/authz.ts src/lib/authz.test.ts src/lib/session.ts
git commit -m "feat(auth): resolve isReadOnly onto the session and add denyReadOnly"
```

---

## Task 3: Close the password-reset door

**Files:**
- Modify: `src/app/actions/auth.ts:346-378` (the `after()` block inside `requestPasswordResetAction`)
- Test: `src/app/actions/auth.reset-demo.test.ts` (create)

**Interfaces:**
- Consumes: `isReadOnlyDemo` from Task 1.
- Produces: nothing.

**Why:** `requestPasswordResetAction` is unauthenticated, so `denyReadOnly` cannot reach it. Demo credentials get handed out; without this, anyone controlling that inbox can take over an `ADMIN` account.

- [ ] **Step 1: Write the failing test**

```ts
// src/app/actions/auth.reset-demo.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isReadOnlyDemo } from "@/lib/read-only-demo";

// The predicate is pure, so this test asserts the DECISION rather than driving
// the whole action (which needs Turnstile, the rate limiter and `after()`).
// The action-level assertion is that the branch exists and is placed before
// createPasswordResetToken — see Step 4.
describe("password reset for a demo account", () => {
  const ORIGINAL = process.env.READ_ONLY_DEMO_EMAILS;
  beforeEach(() => {
    process.env.READ_ONLY_DEMO_EMAILS = "test@gmail.com";
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.READ_ONLY_DEMO_EMAILS;
    else process.env.READ_ONLY_DEMO_EMAILS = ORIGINAL;
  });

  it("identifies the demo address the reset path must skip", () => {
    expect(isReadOnlyDemo("test@gmail.com")).toBe(true);
  });

  it("leaves every other address alone", () => {
    expect(isReadOnlyDemo("someone@dcsim.us")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it passes**

Run: `npx vitest run auth.reset-demo`
Expected: PASS. (This test guards the predicate's contract; Step 4 adds the source assertion that actually pins the branch.)

- [ ] **Step 3: Add the block to the action**

In `src/app/actions/auth.ts`, add the import beside the others at the top:

```ts
import { isReadOnlyDemo } from "@/lib/read-only-demo";
```

Then, inside the `after()` callback, immediately after the existing inactive-account no-op (currently `:350`):

```ts
      const user = await prisma.user.findUnique({ where: { email } });
      // Silently no-op for unknown/inactive accounts (anti-enumeration).
      if (!user || !user.isActive) return;

      // A DEMO account's credentials are handed out deliberately, and the
      // account holds the ADMIN role so the portal renders. A reset link is
      // therefore an account-takeover path that `denyReadOnly` cannot cover:
      // this action is unauthenticated, so there is no session to test.
      //
      // Blocked at the MINT, which is why resetPasswordAction needs no change —
      // a token that is never issued cannot be redeemed. Placed inside the
      // deferred block beside the other silent no-ops so the action still
      // returns its single generic success and reveals nothing about the
      // address.
      if (isReadOnlyDemo(user.email)) return;
```

- [ ] **Step 4: Pin the ordering with a source assertion**

Append to `src/app/actions/auth.reset-demo.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

it("skips the demo account before a reset token is ever minted", () => {
  const src = readFileSync(join(process.cwd(), "src/app/actions/auth.ts"), "utf8");
  const guard = src.indexOf("isReadOnlyDemo(user.email)");
  const mint = src.indexOf("createPasswordResetToken");
  expect(guard).toBeGreaterThan(-1);
  expect(mint).toBeGreaterThan(-1);
  // Order is the whole control: a guard after the mint blocks the EMAIL but
  // leaves a usable token in the database.
  expect(guard).toBeLessThan(mint);
});
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run auth.reset-demo`
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add src/app/actions/auth.ts src/app/actions/auth.reset-demo.test.ts
git commit -m "fix(auth): never mint a password-reset token for a demo account"
```

---

## Task 4: Guard the 13 mutating actions in `src/app/actions/`

**Files (all Modify):** `items.ts`, `drafts.ts`, `account.ts`, `returns.ts`, `permissions.ts`, `signatures.ts`, `receipts.ts`

**Interfaces:**
- Consumes: `denyReadOnly` from Task 2.
- Produces: nothing.

**The pattern.** Add `denyReadOnly` to the existing `@/lib/authz` import in each file. Then, immediately after the existing `require*` line:

```ts
const denied = denyReadOnly(user);
if (denied) return denied;
```

Three shapes, depending on what the action returns:

| Return type | Guard |
|---|---|
| `{ error?: string; ok?: true }` (useActionState) | `if (denied) return denied;` |
| `void` / `Promise<void>` | `if (denied) return;` |
| A wider union (`Result`, `LoanerResult`, …) | `if (denied) return denied;` — the union already admits `{ error: string }`; confirm with `npx tsc --noEmit` |

Where the existing line discards the user (`await requireUser();`), capture it: `const user = await requireUser();`

- [ ] **Step 1: Apply the guard to each action**

Exact call sites — line numbers are pre-edit and drift as you go, so match on the function name:

- [ ] `items.ts:21` `updateItemDetailsAction` — user already bound at `:22`; returns `{error}|{ok}`
- [ ] `drafts.ts:10` `saveDraftAction` — user bound at `:11`; returns `{error}|{ok}`
- [ ] `drafts.ts:35` `deleteDraftAction` — user bound at `:36`; returns `void` → `if (denied) return;`
- [ ] `drafts.ts:67` `deleteDraftAndReturnToAccountAction` — returns `Promise<never>`; it must still `redirect()`, so guard as: `if (denied) redirect("/account");` **before** the delete, never `return denied` (the signature forbids it)
- [ ] `account.ts:15` `changePasswordAction` — user bound at `:16`; returns `{error}|{ok}`
- [ ] `account.ts:49` `saveSignatureAction` — user bound at `:50`; returns `{error}|{ok}`
- [ ] `returns.ts:15` `processReturnAction` — `admin` bound at `:18` inside a `try`; place the guard after that `try/catch` completes
- [ ] `permissions.ts:40` `requestPermissionsAction` — user bound at `:41`
- [ ] `permissions.ts:72` `decidePermissionRequestAction` — `admin` bound at `:73`
- [ ] `signatures.ts:11` `createSignatureAction` — `admin` bound at `:12`
- [ ] `signatures.ts:43` `deleteSignatureAction` — `admin` bound at `:44`; returns `Promise<void>` → `if (denied) return;`
- [ ] `receipts.ts:20` `createReceiptAction` — user bound at `:21`
- [ ] `receipts.ts:183` `notifyPickupAction` — `requireUser()` at `:185` inside a `try`; capture the user and guard after it

**Do NOT touch these — they write nothing:**
`contacts.ts` `searchContactsAction`, `audit.ts` `revealAuditSignatureAction`, `scan.ts` (all four: `lookupScannedItem`, `lookupScannedSerial`, `resolveScannedSerial`, `resolveScannedItemId` — verified reads), `search.ts` `liveSearchAction`, `signatures.ts` `revealOwnSignatureAction`, `receipts.parse.ts`, and everything in `auth.ts`/`unlock.ts` (unauthenticated — no session to test).

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. A union-return mismatch here means that action's result type does not admit `{ error: string }` — widen the local result type rather than casting.

- [ ] **Step 3: Run the existing tests for these files**

Run: `npx vitest run drafts receipts returns permissions items`
Expected: PASS. These suites build sessions via test helpers; any that construct a `SessionUser` literal need `isReadOnly: false` (Task 2 Step 6 should have caught them).

- [ ] **Step 4: Commit**

```bash
git add src/app/actions
git commit -m "feat(auth): refuse writes from a demo account in the user actions"
```

---

## Task 5: Guard the 30 mutating actions in `src/app/admin/actions/`

**Files (all Modify):** `scanned-items.ts`, `audit.ts`, `users.ts`, `units.ts`, `queue.ts`, `receipt-timer.ts`, `contacts.ts`, `categories.ts`, `items.ts`, `public-access.ts`, `readiness.ts`

**Interfaces:**
- Consumes: `denyReadOnly` from Task 2.
- Produces: nothing.

Same pattern and same three return shapes as Task 4.

- [ ] **Step 1: Apply the guard to each action**

- [ ] `scanned-items.ts:29` `createScannedItemsAction` — user bound at `:32`
- [ ] `audit.ts:19` `markAuditedAction` — user at `:20`
- [ ] `audit.ts:68` `recordAuditsAction` — user at `:69`; returns `BulkAuditResult`
- [ ] `users.ts:7` `createUserAction` — `await requireAdmin()` at `:8`, **capture it**
- [ ] `users.ts:20` `toggleUserActiveAction` — `admin` at `:21`; `void` → `if (denied) return;`
- [ ] `users.ts:31` `setUserRoleAction` — `admin` at `:32`; `void` → `if (denied) return;`
- [ ] `units.ts:16` `createUnitAction` — capture the `requireCapability` result
- [ ] `units.ts:34` `renameUnitAction` — `admin` at `:35`
- [ ] `units.ts:56` `deleteUnitAction` — capture; `void` → `if (denied) return;`
- [ ] `units.ts:72` `bulkLearnUnitsAction` — capture
- [ ] `queue.ts:64` `setServiceAction` — capture
- [ ] `queue.ts:94` `setServiceDeadlineAction` — capture
- [ ] `queue.ts:119` `clearServiceAction` — capture; `Promise<void>` → `if (denied) return;`
- [ ] `queue.ts:132` `completeServiceAction` — capture; `Promise<void>` → `if (denied) return;`
- [ ] `queue.ts:154` `reopenServiceAction` — capture; `Promise<void>` → `if (denied) return;`
- [ ] `queue.ts:178` `flagItemsForServiceAction` — capture; returns `BulkQueueResult`
- [ ] `queue.ts:217` `completeServiceItemsAction` — capture; returns `BulkQueueResult`
- [ ] `receipt-timer.ts:17` `setReceiptDueAtAction` — capture
- [ ] `contacts.ts:18` `createContactAction` — `admin` at `:19`
- [ ] `contacts.ts:34` `updateContactAction` — capture
- [ ] `contacts.ts:50` `deleteContactAction` — capture
- [ ] `categories.ts:17` `createCategoryAction` — `admin` at `:18`
- [ ] `categories.ts:38` `deleteCategoryAction` — capture
- [ ] `items.ts:31` `createItemAction` — `admin` at `:32`
- [ ] `items.ts:112` `updateItemAction` — `admin` at `:113`
- [ ] `items.ts:166` `updateItemIdentityAction` — `admin` at `:167`
- [ ] `items.ts:230` `markItemsReadyAction` — capture
- [ ] `items.ts:279` `setItemsLoanerAction` — capture; returns `LoanerResult`
- [ ] `items.ts:360` `renameItemsAction` — `admin` at `:361`; returns `RenameActionResult`
- [ ] `items.ts:385` `toggleItemStatusAction` — capture
- [ ] `items.ts:403` `deleteItemAction` — capture
- [ ] `items.ts:447` `commitImportAction` — `admin` at `:450`
- [ ] `public-access.ts:14` `setPublicAccessPinAction` — `admin` at `:15`
- [ ] `readiness.ts:95` `setReadinessAction` — capture; returns `ReadinessResult`
- [ ] `readiness.ts:128` `setItemsCategoryAction` — `admin` at `:132`

**Do NOT touch these — they write nothing:**
- `verify-seal.ts` `verifyReceiptSealAction` — read-only integrity check, says so at `:11`
- `analytics.ts` `exportStaleDevicesAction`, `exportDroppedDevicesAction` — build a workbook from reads
- `items.ts:337` `previewItemRenameAction` — preview only
- `items.ts:430` `analyzeImportAction` — **deliberately allowed.** `analyzeImport` (`items.service.ts:1265`) is `parseItemsCsv` → `loadExistingBySerial` → `planImport`, all reads. Leaving it open lets the demo show the real two-step import preview; `commitImportAction` above is what stops the write.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Run the admin action tests**

Run: `npx vitest run admin`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/app/admin/actions
git commit -m "feat(auth): refuse writes from a demo account in the admin actions"
```

---

## Task 6: The guard-coverage test

**Files:**
- Create: `src/app/actions/read-only-coverage.test.ts`

**Interfaces:**
- Consumes: the guarded files from Tasks 4 and 5.
- Produces: nothing.

**Why:** the per-call-site approach's one weakness is a future action forgetting the guard. This is the mechanical check. It is **advisory in CI** (per `ci-gates`, only Semgrep and `next build` block a merge) — it reports, it does not prevent.

- [ ] **Step 1: Write the test**

```ts
// src/app/actions/read-only-coverage.test.ts
//
// Every exported Server Action either WRITES (and must call denyReadOnly) or is
// on the read-only allowlist below. Adding an action without doing one or the
// other fails here.
//
// Allowlisting is deliberately a code edit in this file rather than a comment
// annotation in the action: exempting an action from the write guard should be
// something a reviewer sees in the diff.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIRS = ["src/app/actions", "src/app/admin/actions"];

/** Actions that touch no database write. Keep the reason with the entry. */
const READ_ONLY: Record<string, string> = {
  // Reads
  searchContactsAction: "contact type-ahead",
  revealAuditSignatureAction: "returns one stored signature",
  revealOwnSignatureAction: "returns the caller's own signature",
  lookupScannedItem: "scan lookup",
  lookupScannedSerial: "scan lookup",
  resolveScannedSerial: "scan lookup",
  resolveScannedItemId: "scan lookup",
  liveSearchAction: "public search",
  verifyReceiptSealAction: "re-derives and verifies a seal; never mutates",
  exportStaleDevicesAction: "builds a workbook from reads",
  exportDroppedDevicesAction: "builds a workbook from reads",
  previewItemRenameAction: "preview only",
  analyzeImportAction: "parse + plan; the commit half is guarded",
  // Unauthenticated — no SessionUser exists to test. The demo account's own
  // reset path is blocked inside requestPasswordResetAction instead.
  loginAction: "unauthenticated",
  logoutAction: "unauthenticated",
  requestPasswordResetAction: "unauthenticated; has its own demo block",
  resetPasswordAction: "unauthenticated; no token is ever minted for a demo account",
  registerAction: "unauthenticated",
  resendVerificationAction: "unauthenticated",
  unlockAction: "unauthenticated",
};

function actionFiles(): { path: string; src: string }[] {
  return DIRS.flatMap((dir) =>
    readdirSync(join(process.cwd(), dir))
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .map((f) => ({
        path: join(dir, f),
        src: readFileSync(join(process.cwd(), dir, f), "utf8"),
      })),
  );
}

describe("read-only demo guard coverage", () => {
  it("guards every exported action that is not allowlisted", () => {
    const missing: string[] = [];

    for (const { path, src } of actionFiles()) {
      // Split on the exports so each action's body is checked on its own — a
      // single denyReadOnly call must not vouch for its neighbours in the file.
      const parts = src.split(/^export (?:async )?function /m).slice(1);
      for (const part of parts) {
        const name = part.match(/^(\w+)/)?.[1];
        if (!name) continue;
        if (READ_ONLY[name]) continue;
        if (!part.includes("denyReadOnly")) missing.push(`${path} → ${name}`);
      }
    }

    expect(missing, `Actions missing denyReadOnly:\n${missing.join("\n")}`).toEqual([]);
  });

  it("has no stale allowlist entries", () => {
    const all = actionFiles()
      .flatMap(({ src }) => [...src.matchAll(/^export (?:async )?function (\w+)/gm)])
      .map((m) => m[1]);
    const stale = Object.keys(READ_ONLY).filter((name) => !all.includes(name));
    expect(stale, `Allowlisted actions that no longer exist: ${stale.join(", ")}`).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run read-only-coverage`
Expected: PASS, 2 tests. **If it fails, the failure message names the actions Tasks 4-5 missed — go add the guard rather than allowlisting them.**

- [ ] **Step 3: Commit**

```bash
git add src/app/actions/read-only-coverage.test.ts
git commit -m "test(auth): fail when an action forgets the read-only demo guard"
```

---

## Task 7: The banner

**Files:**
- Create: `src/components/ReadOnlyBanner.tsx`
- Modify: `src/app/admin/layout.tsx`

**Interfaces:**
- Consumes: `SessionUser.isReadOnly` from Task 2.
- Produces: `<ReadOnlyBanner />` — a server component taking no props.

**Why the admin layout and not the root layout:** `AdminLayout` already calls `requireAdmin()` and has the user in hand, so the banner costs no extra query. Putting it in the root layout would force `auth()` on every public page and make them all dynamic. It also covers the two `void` actions that cannot render a message of their own (`toggleUserActiveAction`, `setUserRoleAction`), which both live under `/admin`.

**Styling:** `/admin` is a pre-existing page, so use the legacy `globals.css` system, not Tailwind (CLAUDE.md Styling). No layout class on any `<dialog>`/`[popover]` is involved here.

- [ ] **Step 1: Write the component**

```tsx
// src/components/ReadOnlyBanner.tsx
//
// Shown to a demo account on every admin page. Two jobs:
//   1. Nobody mistakes a refused write for a bug.
//   2. It is the VISIBLE TELL that READ_ONLY_DEMO_EMAILS is actually set. The
//      marker fails open (see src/lib/read-only-demo.ts), so a demo session
//      with no banner is a demo session that can write.
export function ReadOnlyBanner() {
  return (
    <div className="card" role="status" style={{ borderColor: "var(--warning, #b45309)" }}>
      <strong>Read-only demo account</strong>
      <p className="subtle" style={{ margin: 0 }}>
        You can browse everything here, but nothing you change is saved.
      </p>
    </div>
  );
}
```

- [ ] **Step 2: Render it from the admin layout**

Replace the body of `src/app/admin/layout.tsx`:

```tsx
import { redirect } from "next/navigation";
import { requireAdmin, AuthError } from "@/lib/authz";
import { SiteHeader } from "@/components/SiteHeader";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  let isReadOnly = false;
  try {
    // Already re-reads role/isActive/capabilities per request — the demo flag
    // rides along on the user it returns, so the banner costs no extra query.
    const user = await requireAdmin();
    isReadOnly = user.isReadOnly;
  } catch (e) {
    if (e instanceof AuthError) redirect(e.code === "FORBIDDEN" ? "/" : "/login");
    throw e;
  }
  return (
    <>
      <SiteHeader />
      <main className="container">
        {isReadOnly && <ReadOnlyBanner />}
        {children}
      </main>
    </>
  );
}
```

- [ ] **Step 3: Typecheck and build**

Run: `npx tsc --noEmit` → Expected: no errors
Run: `npm run build` → Expected: success

- [ ] **Step 4: Commit**

```bash
git add src/components/ReadOnlyBanner.tsx src/app/admin/layout.tsx
git commit -m "feat(admin): show a read-only banner to demo accounts"
```

---

## Task 8: Documentation

**Files (all Modify):** `.env.example`, `CHANGELOG.md`, `docs/SECURITY.md`, `CLAUDE.md`

CLAUDE.md makes this part of the change, not a follow-up.

- [ ] **Step 1: `.env.example`**

```bash
# Comma-separated addresses that may READ the whole app but whose writes are
# refused. Used for demo accounts. Leave blank in normal deployments.
#
# FAILS OPEN: unset or misspelled means nobody is read-only, so a demo account
# keeps whatever its role grants. See docs/SECURITY.md, Known gaps.
READ_ONLY_DEMO_EMAILS=
```

- [ ] **Step 2: `CHANGELOG.md` — new `## 2026-08-11` section at the top (or add to today's if one exists)**

```markdown
## 2026-08-11

### Added
- **Read-only demo accounts.** An address listed in `READ_ONLY_DEMO_EMAILS` can
  sign in and browse the whole application — including the admin portal — but
  every action that would change data is refused with "Demo account — changes
  are not saved." A banner on every admin page says so. The CSV import preview
  still runs, so the two-step import can be demonstrated; committing it cannot.

### Security
- A password-reset link is never issued for a demo account. Demo credentials are
  shared deliberately, so the reset path would otherwise be an account-takeover
  route into an account holding the admin role.

### Notes
- New env var `READ_ONLY_DEMO_EMAILS` (comma-separated, blank by default). Set it
  in Vercel for every environment that hosts a demo account.
- It **fails open**: if the variable is unset or misspelled, the account keeps
  whatever its role grants. The admin banner is the visible tell.
- No migration. Marking an account read-only is configuration, not data.
```

- [ ] **Step 3: `docs/SECURITY.md`**

Add a control entry describing: the env-var marker; `SessionUser.isReadOnly` resolved per request in `defaultGetSession` from the DB email; `denyReadOnly` on every mutating Server Action; the reset-mint block; and that `src/lib/read-only-demo.ts` is security-sensitive.

Add two entries under **Known gaps & accepted risks**:
1. **Fails open.** An unset/misspelled `READ_ONLY_DEMO_EMAILS` leaves the demo account a full production admin. Accepted over a `User.isReadOnly` column to avoid a hand-applied prod migration and an admin toggle. Mitigation: the admin banner.
2. **The demo account reads real production data.** Serials, holder emails, the user list, the contact book, audit history and signature images are visible to anyone being shown the portal. Accepted deliberately — the demo is meant to show real data.

Also note that guard coverage is enforced by an **advisory** test (`read-only-coverage.test.ts`), not a required check.

Bump *Last reviewed* to 2026-08-11.

- [ ] **Step 4: `CLAUDE.md` §1** — add after the "no negative grant" paragraph

```markdown
- **A READ-ONLY DEMO ACCOUNT is not a capability, and must never become one.** An
  address in `READ_ONLY_DEMO_EMAILS` resolves to `SessionUser.isReadOnly` in
  `defaultGetSession`, and every mutating Server Action calls `denyReadOnly(user)`
  and returns its refusal. It sits BESIDE the capability model because
  capabilities are additive with no negative grant — expressing "reads but never
  writes" as a capability would reintroduce exactly the subtractive model that is
  banned above. The account still holds `ADMIN`, because `/admin/*` is gated on
  `ADMINISTER`; the guard is what holds the writes back. It **fails open** (see
  `docs/SECURITY.md`), so the banner in `src/app/admin/layout.tsx` is a control,
  not decoration. `requestPasswordResetAction` carries its own block, because an
  unauthenticated path has no session for `denyReadOnly` to test. New Server
  Actions that write MUST call it — `read-only-coverage.test.ts` reports a miss,
  but it is an advisory check, so it will not stop one merging.
```

- [ ] **Step 5: Commit**

```bash
git add .env.example CHANGELOG.md docs/SECURITY.md CLAUDE.md
git commit -m "docs: record the read-only demo account and its accepted risks"
```

---

## Task 9: Verify end to end

- [ ] **Step 1: Full suite**

Run: `npm test`
Expected: PASS. If another session holds the test DB (`parallel-agents-share-one-test-db`), push the branch and read CI instead.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: success.

- [ ] **Step 3: Manual check against local dev** (see the `local-visual-testing` memory for the local admin login)

Set `READ_ONLY_DEMO_EMAILS` to the local admin's address in `.env.local`, restart the dev server, then confirm:
- [ ] The banner appears on `/admin`.
- [ ] `/admin/users` → creating a user shows the refusal, and the user is not created.
- [ ] `/admin/users` → the role dropdown and Active toggle silently do nothing (the `void` actions).
- [ ] `/admin/items/import` → uploading a CSV still shows preview counts; Commit shows the refusal and adds no rows.
- [ ] `/account` → changing the password shows the refusal.
- [ ] An item page still opens and the audit history still reveals a signature (reads unaffected).

- [ ] **Step 4: Unset the variable and re-check one write** — it must succeed. This proves the guard is driven by the flag rather than broken outright.

---

## Operational steps (NOT part of the code; confirm with the user first)

1. Set `READ_ONLY_DEMO_EMAILS=test@gmail.com` in Vercel, all environments.
2. Stamp `emailVerifiedAt` on the `test@gmail.com` row so sign-in is allowed
   (`checkCredentials` refuses a NULL, `src/modules/auth/credentials.ts:56`).
3. Set that row's `role` to `ADMIN` so `/admin/*` renders.

Steps 2 and 3 are production data changes.
