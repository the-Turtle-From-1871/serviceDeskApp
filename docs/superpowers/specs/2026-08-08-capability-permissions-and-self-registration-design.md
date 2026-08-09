# Capability permissions & self-service registration

**Date:** 2026-08-08
**Status:** Design approved, not yet implemented

## Problem

Three things, which turn out to be one thing:

1. Sign-in is labelled as staff-only (`"Staff sign in"`, `"Staff log in"`) and there is no
   way to create an account — accounts are provisioned only by an admin. People who need
   read access have to ask a technician to make them one.
2. Authorization is a two-value role enum (`ADMIN` / `USER`). There is no tier below
   `USER`, so any account that exists can create hand receipts and edit item holders.
   There is also no way to give someone *one* capability without giving them all of a role.
3. There is no mechanism for a user to ask for more access, and no record of why anyone
   has the access they have.

The three are one problem because self-registration is only safe if there is a tier below
`USER` to register *into*, and that tier is only useful if there is a way to climb out of it.

## Decisions taken during design

These were explicit choices, recorded so a later reader does not re-litigate them:

| Question | Decision |
|---|---|
| What does "can't see everyone's receipts" mean? | Scope the *list* to receipts they are a party to. Public PIN surface untouched. |
| Role ladder or granular capabilities? | Granular capabilities. |
| How granular? | 9 capabilities (see below). |
| How is registration gated? | Verified email, then live immediately. No admin activation step. |
| Request shape? | One request carries several capabilities and one justification; each line decided individually. |
| Decision flow | Email the outcome; require a reason on denial; allow re-requesting; show status on `/account`. |
| Is `ADMINISTER` requestable? | Yes, but flagged red on both the request form and the approval queue. |
| How does an admin approve part of a request? | A pre-checked checklist; unchecking a line denies it. |
| How many denial reasons? | One, covering the whole batch, shown once under the decided group. |
| How is a partial approval shown? | Per-capability rows — green check for approved, red X for denied — on `/account`, in the admin queue's decided list, and in the decision email. |

## Non-goals

- **Not** auth-gating `/receipts/*` or `/i/*`. Public enumerable receipts and items remain
  an accepted requirement (CLAUDE.md). Nothing here narrows the public surface.
- **Not** replacing the `Role` enum. Roles remain, as the baseline capability set.
- **Not** an admin activation step on registration, a domain allowlist, or capability expiry.

---

## 1. Capability model

A `Capability` enum with nine values. Each carries a **risk** of `standard` or `elevated`;
risk drives the red UI treatment and nothing else.

| Capability | Risk | Grants |
|---|---|---|
| `VIEW_INVENTORY` | standard | Browse `/items` and item pages. Baseline for every account; never requestable, because everyone already has it. |
| `VIEW_ALL_RECEIPTS` | standard | See the full hand-receipt list, not just your own. |
| `CREATE_RECEIPTS` | standard | `/receipts/new`, drafts, notify-pickup. |
| `EDIT_ITEM_HOLDER` | standard | An item's current holder email + current position (today's `USER` right, `userItemDetailsSchema`). |
| `MANAGE_ITEMS` | standard | Create/edit/delete/import items, item identity, categories, units, QR sheets. |
| `MANAGE_QUEUE` | standard | Service queue, readiness, service deadlines. |
| `PROCESS_RETURNS` | standard | Close a receipt and return equipment. |
| `VIEW_ANALYTICS` | standard | The analytics dashboard. |
| `ADMINISTER` | **elevated** | Users, permission approvals, access PIN, audit, contact book, named signatures, receipt timers, seal verification. |

### Roles become the baseline set

`Role` gains a third value, `VIEWER`. Roles are not removed — they are the *default*
capability set an account starts from:

```
VIEWER  → VIEW_INVENTORY
USER    → VIEW_INVENTORY, VIEW_ALL_RECEIPTS, CREATE_RECEIPTS, EDIT_ITEM_HOLDER
ADMIN   → all nine
```

`USER` and `ADMIN` baselines are exactly today's rights, so **the migration changes nobody's
access**. `VIEWER` is new and is what self-registration creates.

### Grants are additive only

A `UserCapability` row grants one capability to one user. There is no negative grant — a
capability cannot be subtracted from a role baseline. Revocation deletes the grant row; to
reduce a `USER` below their baseline you change their role, which is the existing lever.

> **Why additive-only:** a subtractive model makes the effective set depend on the *order*
> of two tables and produces the question "does a deny-row beat an admin's grant?". There
> is no good answer, and the wrong one is a privilege bug. Additive-only has one rule.

### Effective capabilities

```ts
// src/modules/users/capabilities.ts — pure, no Prisma import
effectiveCapabilities(role, grants) === roleBaseline(role) ∪ grants
```

A leaf file with no DB client, unit-tested directly, following the `readiness.ts` /
`recipient-search.ts` convention. It is the **single** definition of the mapping — do not
write a second one in SQL or in a component.

---

## 2. Authorization layer

`src/lib/authz.ts` gains `requireCapability(cap)` beside `requireUser` / `requireAdmin`.

**`requireAdmin()` is redefined as `requireCapability("ADMINISTER")`.** This is the hinge of
the whole migration: all 29 existing `requireAdmin()` call sites keep working unchanged, and
a granted `ADMINISTER` works everywhere from the first commit. Call sites then move to
narrower capabilities incrementally:

| Files | Moves to |
|---|---|
| `admin/actions/items.ts`, `categories.ts`, `units.ts`, `admin/items/**`, `items/qr-sheet/pdf/route.ts` | `MANAGE_ITEMS` |
| `admin/actions/queue.ts`, `readiness.ts`, `admin/queue/page.tsx`, `MarkReadyButton`, `ReadinessControls` | `MANAGE_QUEUE` |
| `actions/returns.ts`, `receipts/[n]/return/page.tsx` | `PROCESS_RETURNS` |
| `admin/analytics/page.tsx` | `VIEW_ANALYTICS` |
| users, audit, contacts, signatures, public-access, receipt-timer, verify-seal, `admin/layout.tsx` | stays `ADMINISTER` |

`updateItemDetailsAction` currently picks its Zod schema by role; it picks by capability
instead — `MANAGE_ITEMS` gets the eight-field `editableItemFields` schema, `EDIT_ITEM_HOLDER`
gets the two-field `userItemDetailsSchema`, neither gets a refusal. The server-side field
restriction stays server-side.

### Freshness

`SessionUser` gains `capabilities: Capability[]`. `defaultGetSession` already re-reads
`role` + `isActive` from the DB on every request; capabilities ride along as an `include` on
that **same** query. No extra round trip, no N+1, and a revoked capability dies on the
requester's next request — the identical guarantee role changes already have.

The JWT never carries capabilities. It cannot: a token minted before a grant would be stale,
and the whole point of the per-request read is that it is not.

---

## 3. Self-service registration

### Flow

1. `/register` — a public page (Turnstile-challenged) collecting rank, name, email,
   password, unit, contact number. Reuses `registerSchema`, which already exists unused in
   `users.schema.ts` for exactly this.
2. `registerAction` creates `User { role: VIEWER, emailVerifiedAt: null }` and mails a
   verification link.
3. `/verify-email?token=…` stamps `emailVerifiedAt` and signs the user in.
4. Sign-in before verification is refused with a distinct "check your email" message and a
   resend link. **Without this refusal, "verify email only" gates nothing.**

### Rate limiting and abuse

Follows `requestPasswordResetAction`, not `loginAction`:

- New `"register"` scope. Composite `(scope, IP, hashed email)` under the shared spray
  ceiling, narrow bucket spent first.
- Token spent **before** the work and **never refunded** — with registration the abuse is
  volume itself, so there is no "success" that deserves its budget back.
- Turnstile verified after the limiter and before any DB write.
- The verification-resend endpoint carries its own bucket.

### Anti-enumeration

`registerAction` always returns the same generic success. The account lookup, creation and
mail send are deferred through `after()` so response time does not reveal whether the address
was already registered — the same construction, and the same reason, as the reset flow. An
already-registered address receives a "someone tried to register with your address" mail
rather than a second account.

### Existing accounts

The migration backfills `emailVerifiedAt = now()` for every existing user. They were
admin-provisioned; locking the service desk out behind a verification mail they never
received would be an outage.

The `mdm-import@service.invalid` service account is included in the backfill and is otherwise
untouched — it stays `isActive: false` and non-loginable, and its `deactivatedAt` stays NULL
so the purge worker continues to ignore it.

---

## 4. "My hand receipts"

A `/receipts` list page, which does not exist today. Behaviour depends on one capability:

- **With `VIEW_ALL_RECEIPTS`:** every receipt, paginated and sorted server-side.
- **Without it:** only receipts where the signed-in user's **verified** email appears as a
  party. Matched on the verified address only — an unverified one proves nothing.

Both paths are server-side paginated with `take` + keyset, and `select` only the columns the
list renders — never signature blobs.

### Deliberately unchanged

`/receipts/<number>`, `/receipts/<number>/pdf` and `/i/<id>` stay public and PIN-gated.
Making a signed-in `VIEWER` see *less* than an anonymous PIN holder would be incoherent, and
narrowing the public surface is explicitly out of scope.

> **This is therefore a scoping of what is enumerable to a signed-in user, not a
> confidentiality boundary.** Someone without `VIEW_ALL_RECEIPTS` who knows a receipt number
> can still open it, exactly as any PIN holder can. That was the accepted trade-off; it goes
> in `docs/SECURITY.md` under Known gaps so nobody later mistakes the list filter for a wall.

---

## 5. Permission requests

### Schema

```
PermissionRequest
  id, userId, justification (required, min 20 chars),
  status OPEN | CLOSED, createdAt, decidedAt, decidedById,
  denialReason (nullable — set when any line is denied)

PermissionRequestItem
  id, requestId, capability,
  decision PENDING | APPROVED | DENIED,
  @@unique([requestId, capability])
```

A request `CLOSED`s when no `PENDING` items remain. Approving a line writes a
`UserCapability` row — `@@unique([userId, capability])`, so approval is idempotent — stamped
with `sourceRequestId` and `grantedById`. "Why does this person hold `PROCESS_RETURNS`?"
therefore always resolves to a justification, a decision and a named approver.

The denial reason lives on the **request**, not the item: one reason covers the whole batch,
mirroring the single justification on the request side. Denied items read it through their
request.

### Rules

- A capability already held, or already pending, cannot be requested. Enforced in the
  service, not just hidden in the form.
- `VIEW_INVENTORY` is not requestable — everyone has it.
- **An admin may never decide their own request.** This is the self-grant hole on
  `ADMINISTER` and is the one guard whose absence is a privilege-escalation bug, not a
  usability wart.
- Denial requires a reason. Re-requesting a denied capability is allowed with no cooldown —
  the admin queue is the throttle.
- Deciding is `ADMINISTER`-gated and runs inside a transaction: the grant rows and the item
  decisions commit together or not at all.

### Revocation

An admin revokes a granted capability from the user's row in `/admin/users`, which deletes
the `UserCapability` row. The originating request keeps its `APPROVED` decision — the
history of what was decided is not rewritten by a later revocation.

---

## 6. UI

### `/account` — "Your permissions"

Current capabilities, requests still pending, and recent decisions. The request form is a
checkbox list of everything the user does not already hold, plus one justification textarea.

`ADMINISTER` renders in the danger treatment with a line explaining it grants full
administrative control.

**A decided request shows its outcome per capability**, so a partial approval reads
correctly instead of as a flat "decided":

```
Requested 6 Aug — decided 8 Aug by SSG Alvarez

  ✓  Create hand receipts        Approved
  ✓  Manage service queue        Approved
  ✗  Administer                  Denied
  ✗  Process returns             Denied

  Reason given: Returns and admin access are limited to the
  two senior technicians. Ask again after handover.
```

Green check for approved, red X for denied, using `lucide-react` (`Check` / `X`) like the
rest of the app. Two constraints on that:

- **The icon is never the only signal.** Each row also carries the word "Approved" or
  "Denied", the icon is `aria-hidden`, and colour is not load-bearing — red/green alone
  fails both colour-blind users and a screen reader.
- The denial reason is shown **once**, under the group, because it covers the whole batch.

A request with nothing denied shows all green and no reason block. A request denied outright
shows all red.

### `/admin/permissions` — the approval queue

Open requests newest first: requester, submitted date, justification, and the requested
capabilities as a **pre-checked checklist**. The admin unchecks anything they are not
granting and submits once; unchecked lines are recorded as `DENIED`.

- `ADMINISTER` renders red **and starts unchecked** — granting it should take a deliberate
  tick, not a deliberate untick.
- A required reason field appears as soon as any box is unchecked.
- The submit button is reactive: `Approve 3 of 3` / `Approve 2 of 3` / `Deny all`, so the
  admin cannot misread what they are about to do.

Once decided, the request drops out of the open queue into a "Recently decided" list showing
the same green-check / red-X rows the requester sees, so both sides read the outcome
identically.

Reached from the admin Dashboard hub with a pending count. **Not a new nav-rail tab** —
`nav.ts` documents five tabs as the practical ceiling at 375px and the rail is already at
five for an admin.

### Styling

All of this is the legacy `globals.css` world, not the Tailwind zone. Per CLAUDE.md, neither
`npm run build` nor jsdom is evidence for any of it — the red treatment and the checklist
layout are verified in a real browser before the work is called done.

### Copy

| Where | From | To |
|---|---|---|
| `src/components/nav.ts:26` | `"Staff sign in"` | `"Sign in"` |
| `src/app/page.tsx:62` | `"Staff log in"` | `"Log in"` |
| `/login` | — | add "Create account" link |
| `src/app/page.tsx` (logged-out card) | — | add "Create account" link |
| `src/app/page.tsx` "Who it is for" | "provisioned by an administrator" | describes self-registration |

---

## 7. Email

One new transactional template and sender, following `send-receipt-email.ts`:

- **Verify your email** — the registration link.
- **Your permission request was decided** — the same per-capability breakdown as `/account`,
  approved lines then denied lines, with the reason once at the end. Sent on decision.
  Uses `✓` / `✗` text characters rather than icons or background colours, because mail
  clients strip CSS and block images; the word "Approved" / "Denied" carries the meaning
  either way.

Both go through the existing mailer. Per the delivery note in project memory, every link uses
`APP_URL` (`https://www.dcsim.us`) — a `vercel.app` link in the body is what previously broke
`.mil` delivery.

---

## 8. Migration

One Prisma migration:

- `Role` += `VIEWER`
- `Capability` enum (9 values)
- `UserCapability` — `@@unique([userId, capability])`, indexed on `userId`
- `PermissionRequest`, `PermissionRequestItem`
- `EmailVerificationToken` — mirrors `PasswordResetToken` (hashed token, expiry, `usedAt`)
- `User.emailVerifiedAt` — nullable, **backfilled to `now()` for existing rows**

Authored via `migrate diff --from-config-datasource --to-schema` + `migrate deploy`;
`migrate dev` cannot run in this shell. Applied to Supabase **before** the merge deploys —
`next build` never runs `migrate deploy`, and code selecting `emailVerifiedAt` against a
column that does not exist yet is a production 500.

---

## 9. Testing

| Layer | Covers |
|---|---|
| `capabilities.test.ts` | `roleBaseline`, `effectiveCapabilities`, risk classification. Pure, no DB. |
| `authz.test.ts` | `requireCapability` admits/refuses; `requireAdmin` still refuses a non-`ADMINISTER` caller. |
| `auth.register.test.ts` | Rate-limit spend-no-refund, Turnstile refusal, constant-time enumeration response, unverified sign-in refused. |
| `permissions.service.test.ts` | Duplicate/pending guard, self-decision refusal, denial-reason requirement, idempotent grant, transactional decide. |
| `*.test.tsx` (jsdom) | Request form validation; approval checklist — `ADMINISTER` unchecked by default, reason field appears on uncheck, button label tracks state. |
| `tests/e2e` | register → verify → sign in → see only own receipts → request → admin approves part → capability works, denied one does not. |

Note from project memory: two agents running `npm test` concurrently truncate each other's
test DB. Run the suite once, alone.

---

## 10. Sequencing

Three PRs. One would be too large to review, and the first two are independently useful.

**PR 1 — Capability foundation.** Enum, `UserCapability`, `capabilities.ts`,
`requireCapability`, `requireAdmin` redefined, call sites migrated, session include.
No user-visible change; existing roles behave identically.

**PR 2 — Registration.** `/register`, email verification, `VIEWER`, the `/receipts` list with
own-receipt scoping, and all copy changes.

**PR 3 — Permission requests.** Request/decision schema, service, `/account` card,
`/admin/permissions` queue, decision email.

Each is branch → PR → green `Semgrep SAST` + `Build (next build)` → merge. Note CI does not
run the test suite; run `npm test` before opening each PR.

---

## 11. Documentation to update (same commits, non-negotiable)

- **CLAUDE.md §1** — two rules change and must be rewritten, not appended to: "There is NO
  public self-registration" is now false, and "Authorization is role-based… gate on the ROLE"
  becomes the capability model with roles as baselines. Add `VIEWER`. Update the
  `updateItemDetailsAction` note, which currently says the schema is picked by role.
- **`docs/SECURITY.md`** — new entries for registration, email verification, capability
  authorization, and the request workflow; bump *Last reviewed*. Two additions to **Known
  gaps & accepted risks**:
  1. A self-registered, email-verified account bypasses the public PIN gate, so anyone with a
     working mailbox can reach the item and receipt surfaces without the PIN.
  2. The own-receipts scoping is a list filter, not a confidentiality boundary — a receipt
     number still opens for anyone.
- **`.claude/rules/backend-constraints.md`** — the capability model and the additive-only
  grant rule.
- **`CHANGELOG.md`** — an entry per PR under its date, with the migration under **Notes**.
