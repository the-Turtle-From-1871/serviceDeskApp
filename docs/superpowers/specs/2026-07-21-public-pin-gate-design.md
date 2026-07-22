# Public-access PIN gate — design

**Date:** 2026-07-21
**Status:** Approved design, pending implementation plan
**Author:** ops@turtolabs.com (Turto Labs) + Claude

## Problem

The public, unauthenticated surface of the hand-receipt app exposes PII to
anyone on the internet: the home search page enumerates the device catalog by
serial, item pages (`/i/<id>`) show serials / home unit / current holder /
receipt history, and receipt pages + PDFs (`/receipts/<num>`, `/receipts/<num>/pdf`)
show party names, contacts, and signature images. Today this is an **accepted
requirement** (see `CLAUDE.md`), but the team is now exercising the documented
"harden later if the team asks" path.

**Goal:** gate the whole public surface behind a shared 8-digit PIN for
logged-out visitors, to limit casual PII browsing/enumeration, while keeping it
easy for a recipient to reach their hand receipt (enter the PIN once, remembered
for 7 days).

This is a **deliberate feature change**, not a security auto-remediation — the
`CLAUDE.md` accepted-requirement note is updated in the same change.

## Decisions (locked)

| Decision | Choice |
|---|---|
| What the PIN gates | **Everything public**: `/`, `/i/*`, `/receipts/*` (pages, PDF route, and the home search server actions). Logged-in users bypass entirely. |
| PIN storage | **DB-stored, bcrypt-hashed**, admin-settable in-app (no redeploy to rotate). |
| Unlock duration | **7 days** (rolling cookie). |
| Enforcement mechanism | **Next.js 16 proxy** (`src/proxy.ts`) — single choke point over the public routes. |
| Brute-force protection | **Lightweight**: bcrypt compare + a small fixed delay on failed attempts. No lockout table. |

## Non-goals

- Per-user or per-recipient PINs. One shared org PIN.
- Immediate global revocation of already-unlocked sessions on rotation (see
  Tradeoffs). Cookies lapse within 7 days.
- Changing any existing `requireUser` / `requireAdmin` authorization. All
  current per-route authz stays exactly where it is; the proxy is **not** an
  authz boundary.
- Making receipt identifiers unguessable or hiding signatures on the page
  itself — out of scope for this change.

## Architecture

### Enforcement point — `src/proxy.ts` (Next 16 proxy)

Next.js 16 renamed the `middleware` convention to **`proxy`** (`middleware.ts`
is deprecated). The file lives at `src/proxy.ts` (same level as `src/app`),
exports `proxy(request)` and a `config` with a matcher. It runs on the **edge
runtime** by default — so it must not touch Prisma or bcrypt.

Matcher (only the public surface):

```ts
export const config = { matcher: ['/', '/i/:path*', '/receipts/:path*'] }
```

Per-request logic:

1. **Kill-switch / rollout flag.** If `process.env.PUBLIC_ACCESS_PIN_ENABLED`
   is not `"true"`, `return NextResponse.next()` — behaves exactly like today
   (open public access). This makes rollout a deliberate flip and gives an
   emergency off-switch. (The proxy cannot read the DB at the edge, so it cannot
   itself detect "no PIN configured yet"; the flag is the edge-visible signal.)
2. **Logged-in bypass.** `const token = await getToken({ req, secret:
   process.env.AUTH_SECRET, secureCookie: <prod> })` from `next-auth/jwt`. This
   decodes the Auth.js session cookie at the edge with no DB call and **without**
   running our `jwt` callback (the callback's Prisma freshness read only fires
   inside `auth()`, not `getToken`). If `token` is non-null → `NextResponse.next()`.
   - Freshness is intentionally *not* checked here: a stale token at worst lets a
     just-deactivated account skip a PIN to view public pages — not an authz
     decision. Real authz still re-reads role/isActive per route.
3. **Unlock cookie.** Read the `pub_unlock` cookie, verify its HMAC signature and
   expiry with `crypto.subtle` (Web Crypto, edge-safe). Valid → `NextResponse.next()`.
4. **Otherwise redirect** to `/unlock?next=<sanitized current path>` (307).

### Unlock cookie (self-contained, HMAC-signed)

Because the edge proxy can't do a DB lookup, the cookie carries its own proof.

- **Name:** `pub_unlock` (prod: `__Secure-pub_unlock`). `httpOnly`, `secure`
  (prod), `sameSite=lax`, `path=/`, `maxAge = 7 days`.
- **Value:** `${expEpochMs}.${sigBase64Url}` where
  `sig = HMAC-SHA256(AUTH_SECRET, String(expEpochMs))`.
- **Verify (edge):** recompute HMAC over `expEpochMs`, constant-time-compare to
  `sig`, and require `expEpochMs > now`. No DB, no PIN hash needed at the edge.
- **Mint (Node):** the unlock server action computes `exp = now + 7d`, signs, and
  sets the cookie via `cookies()` from `next/headers`.

`AUTH_SECRET` already exists (Auth.js). No new secret required.

### PIN storage — `PublicAccessSetting` table

A single-row config table (there is no settings table today):

```prisma
model PublicAccessSetting {
  id          String   @id @default("singleton") // enforce one row
  pinHash     String                              // bcrypt hash of the 8-digit PIN
  updatedAt   DateTime @updatedAt
  updatedBy   User?    @relation("PinUpdates", fields: [updatedById], references: [id], onDelete: SetNull)
  updatedById String?
}
```

- One row, `upsert`ed on set. `updatedById` denormalization mirrors existing
  history patterns (nullable + SetNull so it survives account deletion).
- Migration authored via `prisma migrate diff --script` + `migrate deploy`
  (this shell can't run `migrate dev` — see repo memory), applied to prod via the
  Supabase MCP with the CRLF-sha256 checksum row.
- New tables inherit RLS-enabled/deny-all via the existing `rls_auto_enable`
  trigger — no policy added (app reaches it only through Prisma). Consistent
  with `CLAUDE.md` §6.

### Module split (edge vs Node)

- `src/lib/public-access-cookie.ts` — **edge-safe** (Web Crypto only): cookie
  name resolution, `signUnlockValue`, `verifyUnlockValue`, `mintUnlockCookieOptions`,
  `sanitizeNext`. Imported by both `proxy.ts` and the Node action. **No** `import
  'server-only'` bcrypt/Prisma here so the edge bundle stays clean.
- `src/lib/public-access.ts` — **Node/server-only** (`import 'server-only'`):
  `getPinHash()`, `verifyPin(pin)` (bcrypt), `setPin(pin, userId)` (bcrypt hash +
  upsert). Talks to Prisma.

### `/unlock` page + `unlockAction`

- `src/app/unlock/page.tsx` — public page (the proxy allows `/unlock`; it is not
  in the matcher). Renders an 8-digit numeric input + a short "enter the access
  PIN to view receipts" explainer, plus a "staff? log in" link to `/login`. Reads
  and forwards the `next` query param (already sanitized server-side on submit).
- `unlockAction(formData)` — server action (Node):
  1. Zod-parse: exactly 8 digits.
  2. `verifyPin` (bcrypt). On failure: `await` a small fixed delay (e.g. ~400ms),
     return a generic "Incorrect PIN" (no distinction from "no PIN set").
  3. On success: mint + set the `pub_unlock` cookie, `redirect(sanitizeNext(next))`.
- If no PIN is configured (`pinHash` absent), `verifyPin` returns false → same
  generic failure. (Operationally, an admin sets the PIN before flipping
  `PUBLIC_ACCESS_PIN_ENABLED=true`.)

### Admin PIN management

- A "Public access PIN" section on the **`/admin` dashboard** (it's an org-wide
  setting, not a personal one). Shows "last changed <when> by <name>" and a
  set/rotate form (new PIN + confirm).
- `setPublicAccessPinAction(formData)` — server action starting with
  `requireAdmin()`. Zod: exactly 8 digits, both fields match. bcrypt-hash →
  `upsert` the singleton row with `updatedById = admin.id`.
- Rotating the PIN takes effect immediately for **new** unlock attempts. Existing
  `pub_unlock` cookies remain valid until they expire (≤7 days) — see Tradeoffs.

## Open-redirect safety

`next` is attacker-controllable. `sanitizeNext(next)` accepts only a same-origin
**relative** path (must start with a single `/`, not `//` or a scheme); anything
else falls back to `/`. Applied both when building the redirect in the proxy and
before `redirect()` in `unlockAction`.

## Request-flow coverage check

| Public entry | Covered by |
|---|---|
| Home `/` page load | matcher `/` |
| Home search server-action POST (to `/`) | matcher `/` (proxy runs on all methods) |
| Item page `/i/<id>` | matcher `/i/:path*` |
| Receipt page `/receipts/<num>` | matcher `/receipts/:path*` |
| Receipt PDF `/receipts/<num>/pdf` | matcher `/receipts/:path*` |

Authed public-path sub-routes (`/receipts/new`, `/receipts/<num>/return`,
`/i/<id>/qr/pdf`) already call `requireUser`; logged-out visitors hit `/unlock`
first, then still need `/login`. Logged-in staff bypass the gate, so this is
transparent for them.

## Tradeoffs & residual risks (accepted)

- **Rotation is not retroactive.** A leaked PIN, once rotated, still lets holders
  of an existing `pub_unlock` cookie in for ≤7 days. Mitigation: the 7-day window
  is the cap; a shorter unlock duration or bumping `AUTH_SECRET` (invalidates all
  unlock cookies *and* logs everyone out) are the levers if immediate revocation
  is ever needed. Documented for the admin.
- **Shared 8-digit PIN** (10^8 space) + bcrypt + failure delay is adequate for
  "limit casual PII browsing," not a defense against a determined distributed
  attacker. Matches the stated goal. A per-IP throttle is a clean future add
  (the verify action is structured to allow it).
- **Presence-not-freshness logged-in bypass** — acceptable, since bypassing the
  PIN only reaches already-public pages, and all real authz stays per-route.

## Testing strategy

- **Unit (Vitest):** `signUnlockValue`/`verifyUnlockValue` round-trip, expiry
  rejection, tamper rejection; `sanitizeNext` (`/`, `//evil`, `https://evil`,
  `/i/abc`); `verifyPin`/`setPin` against the test DB; `unlockAction` +
  `setPublicAccessPinAction` (happy path, wrong PIN, non-8-digit, non-admin
  rejected).
- **Proxy logic:** factor the decision into a pure helper
  (`decidePublicAccess({ flagEnabled, token, cookieValue, now })` →
  `'allow' | 'redirect'`) and unit-test that; the thin `proxy.ts` wraps it.
- **E2E / manual (verify skill, real browser):** flag off = open; flag on =
  logged-out visitor redirected to `/unlock`; correct PIN unlocks and `next`
  returns them to the item/receipt; logged-in user never sees `/unlock`; PDF
  route gated. UI/layout of `/unlock` measured in a real browser (jsdom has no
  layout engine, per repo memory).
- Note: parallel test runs share one test DB (repo memory) — run the suite
  solo.

## Documentation updates (same change)

- **`CLAUDE.md`** — rewrite the "ACCEPTED REQUIREMENT — public, enumerable
  receipts AND items" note to record that the public surface is now **PIN-gated
  for logged-out users** via `src/proxy.ts`; document that the proxy is a
  non-authz gate (distinct from the "enforce authz in the server function, not
  the proxy" rule, which still holds for real authz); add `PUBLIC_ACCESS_PIN_ENABLED`
  to the env/secret notes.
- **`CHANGELOG.md`** — `## 2026-07-21`, **Added** (public PIN gate) +
  **Security** + a **Notes** subsection for the new table, migration, and env var.
- **`README.md` / setup** — document `PUBLIC_ACCESS_PIN_ENABLED`, the two-step
  rollout (set PIN in-app → flip flag), and that rotation is not retroactive.
- **Repo memory** — update `open-followups` / add a note recording the gate and
  its rollout flag.

## Rollout steps

1. Merge code + apply the `PublicAccessSetting` migration (local + prod).
2. Admin sets the PIN in-app.
3. Set `PUBLIC_ACCESS_PIN_ENABLED=true` in Vercel (+ local `.env`) and redeploy.
4. Verify logged-out flow in a real browser.

To disable: unset/`false` the flag (redeploy) — public access reverts to open.
