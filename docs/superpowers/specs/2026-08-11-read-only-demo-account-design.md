# Read-only demo account — design

**Date:** 2026-08-11
**Status:** approved (pending spec review)

## Problem

We want to show people the admin portal — the real one, with real data — without
letting them change anything. The target account is `test@gmail.com`.

Concretely it must:

1. Reach every read surface of `/admin/*` and the rest of the app.
2. Have every write refused, with a message rather than a crash.
3. Sign in without confirming its email address.
4. Be unable to change its own password — through **any** door.

## Why this needs a new concept

Authorization here is capability-based and **additive**: `effectiveCapabilities`
(`src/modules/users/capabilities.ts:78`) unions the role baseline with grants, and
CLAUDE.md §1 records that there is deliberately **no negative grant** — a
subtractive model makes the answer depend on read order, and "does a deny beat a
grant?" is a privilege bug.

More importantly, an admin **page** and the **write action** on that page are
gated by the *same* check: `requireAdmin()` is a thin alias for
`requireCapability("ADMINISTER")` (`src/lib/authz.ts:100`). No capability
separates reading `/admin/users` from writing it.

So "read the admin portal, write nothing" is not expressible in the existing
model. This adds a narrow, explicitly-scoped concept beside it — **not** a
negative capability grant. The capability model is untouched.

## Accepted tradeoffs

Both were raised and accepted by the product owner:

- **The demo account reads real production data.** Whoever is being shown the
  portal can see real serials, real holder emails, the full user list, the
  contact book, audit history and stored signature images. This is a genuine
  disclosure, chosen deliberately over a seeded demo database.
- **The read-only marker fails OPEN.** It lives in an environment variable. If
  `READ_ONLY_DEMO_EMAILS` is unset, misspelled, or missed on a new deploy, the
  account is a **full production admin** with no refusal anywhere. A
  `User.isReadOnly` column would fail closed; the env var was chosen for having
  no prod migration, no admin UI that could flip it by accident, and instant
  revocability. The banner (§4) is the visible tell that the flag is live.

Both go in `docs/SECURITY.md` under **Known gaps & accepted risks**.

## Design

### 1. Marking the account

New pure module `src/lib/read-only-demo.ts`:

```ts
export function isReadOnlyDemo(email: string): boolean
```

Reads `READ_ONLY_DEMO_EMAILS` (comma-separated), trims and lowercases both sides.
No Prisma, no `server-only` import — pure and directly unit-testable, the same
reason `capabilities.ts` and `readiness.ts` are split out.

`SessionUser` (`src/lib/authz.ts:9`) gains `isReadOnly: boolean`. It is resolved
in exactly **one** place — `defaultGetSession` (`authz.ts:38`) — which already
re-reads `role`/`isActive`/`capabilities` per request. Add `email: true` to that
same `select`, so:

- the flag is read from the **DB**, not the JWT;
- it costs **no extra query** (no N+1);
- it is re-evaluated per request, like every other freshness check here.

The account keeps **role `ADMIN`**, because `/admin/*` is gated on `ADMINISTER`
and that is the only way the portal renders.

### 2. Refusing the writes

In `src/lib/authz.ts`:

```ts
export const DEMO_REFUSAL = { error: "Demo account — changes are not saved." } as const;

/** null if the caller may write; the refusal object if not. */
export function denyReadOnly(user: SessionUser): typeof DEMO_REFUSAL | null;
```

Each mutating Server Action keeps its existing `require*` line **unchanged** and
gains two lines:

```ts
const user = await requireCapability("MANAGE_ITEMS");
const denied = denyReadOnly(user);
if (denied) return denied;
```

Scope: ~50 mutating actions of the 64 in `src/app/actions/*` and
`src/app/admin/actions/*` (24 non-test files). Read-only actions
(`search.ts`, `receipts.parse.ts`) are excluded.

`changePasswordAction` and `saveSignatureAction` (`src/app/actions/account.ts`)
are inside this set — that is requirement 4's authenticated door.

**Known gap, deliberate:** a few actions return `void` and are bare
`<form action={fn}>` — e.g. `toggleUserActiveAction` and `setUserRoleAction`
(`src/app/admin/actions/users.ts:20,31`). They have nowhere to render a message,
so they no-op **silently**. Converting them to `useActionState` is scope creep;
§4's banner covers the ambiguity instead.

### 3. Email verification and the password-reset door

**Email confirmation — data, no code.** `checkCredentials`
(`src/modules/auth/credentials.ts:56`) refuses sign-in on `!user.emailVerifiedAt`.
We stamp `emailVerifiedAt` on that one row.

We explicitly do **not** add a demo bypass to `checkCredentials`. The order in
that function — password verified *before* verification state is consulted — is
load-bearing: checking verification first turns the login form into an
account-existence oracle for any address.

**Password reset is a second door, and `denyReadOnly` cannot reach it.**
`requestPasswordResetAction` (`src/app/actions/auth.ts:317`) is unauthenticated,
so there is no `SessionUser` to test. Since demo credentials are handed out, and
this is an `ADMIN` account, anyone controlling that inbox could take it over —
defeating requirement 4 entirely.

One line, inside the existing `after()` block, next to the anti-enumeration
no-op at `auth.ts:350`:

```ts
if (!user || !user.isActive) return;
if (isReadOnlyDemo(email)) return;   // demo credentials are handed out; no reset path
```

Placed there so the action still returns its generic success and reveals nothing
about the address. `resetPasswordAction` needs **no** change: a token that is
never minted cannot be redeemed.

### 4. Making it unambiguous, and keeping it enforced

- **Banner in the app shell** whenever `session.user.isReadOnly`:
  *"Read-only demo account — nothing you change here is saved."* One component,
  one layout edit. Covers the silent `void` actions from §2, and is the visible
  tell that the fail-open env var is actually set.
- **Guard-coverage test.** Walks `src/app/actions/*.ts` and
  `src/app/admin/actions/*.ts` and fails if an exported mutating `*Action` does
  not call `denyReadOnly`. This is the mechanical enforcement that the
  per-call-site approach otherwise lacks — a future action cannot quietly forget
  it. Read-only actions sit on an explicit allowlist in the test, so exempting
  one is a deliberate, reviewable edit.

## Testing

| Unit | Assertion |
|---|---|
| `read-only-demo.test.ts` | parsing, whitespace, case, empty/unset var, multiple emails |
| `authz.test.ts` | `SessionUser.isReadOnly` resolves from DB email; `denyReadOnly` returns the refusal only for demo accounts |
| `auth.reset.test.ts` | no `PasswordResetToken` is minted for a demo email, and the action still returns generic success |
| guard-coverage test | every mutating action calls `denyReadOnly` |

Per `parallel-agents-share-one-test-db`, if another session holds the test DB,
push and let CI run the full suite.

## Rejected alternatives

- **Central gate on the `Next-Action` header.** One file, impossible to forget,
  but leans on a Next.js **internal** header (AGENTS.md warns this version
  diverges from assumptions), and refusals hit the error boundary instead of the
  form — losing the inline message.
- **Prisma client extension + AsyncLocalStorage.** Airtight at the DB boundary,
  but the most machinery, the worst error messages, and it would block
  incidental writes on read paths.
- **Seeded demo database.** Removes the read-exposure risk entirely; rejected
  because the demo must show real data.
- **`User.isReadOnly` column.** Fails closed and is reusable, but needs a prod
  migration hand-applied via the Supabase MCP plus new admin UI. Rejected for a
  single demo account.

## Docs to update in the same commit

Non-negotiable per CLAUDE.md:

- `CHANGELOG.md` — under `## 2026-08-11`, with a **Notes** subsection for the new env var
- `docs/SECURITY.md` — the new control, the reset-path block, both accepted risks
  in **Known gaps**, and a bumped *Last reviewed*
- `CLAUDE.md` §1 — read-only demo accounts sit beside the capability model, not inside it
- `.env.example` — `READ_ONLY_DEMO_EMAILS`

## Operational steps (not code)

1. Set `READ_ONLY_DEMO_EMAILS=test@gmail.com` in Vercel (all environments).
2. Stamp `emailVerifiedAt` on the `test@gmail.com` row.
3. Set that row's `role` to `ADMIN`.

Steps 2 and 3 are prod data changes and will be confirmed before being run.
