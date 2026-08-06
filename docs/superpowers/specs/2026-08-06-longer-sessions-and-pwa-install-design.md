# Longer sessions, and a real home-screen install

**Date:** 2026-08-06
**Status:** implemented (PR #56)

## Problem

Sessions were **10 hours absolute / 4 hours idle**. That framing was written for a
shift at a desk, and it did not survive contact with how the app is actually used.

Technicians install the app to the iOS home screen. A home-screen web app keeps
**its own cookie jar** — it never inherits a login done in Safari — so the icon
was its own sign-in surface, and the 4-hour idle window had usually lapsed by the
next time anyone tapped it. The practical result was the login form on most
mornings and again after lunch.

That is not a neutral cost. Re-authenticating twice a day on a personal phone
pushes people to keep the password somewhere convenient, which is worse for the
thing the short window was meant to protect.

## Decision

**30 days absolute / 7 days idle**, for browser and home-screen app alike.

### Why not a longer session for the installed app only

Considered and rejected. Standalone mode is only detectable client-side
(`navigator.standalone`, `display-mode: standalone`), so any "I am the installed
app, grant me longer" signal is attacker-supplied. That would be a self-declared
privilege upgrade — a worse control than the one it replaced. Whatever we pick
applies to everyone.

### Why a long window is affordable here

Session length was never this app's fast path to cutting someone off, and still
is not:

- `requireUser`/`requireAdmin` re-read `role` + `isActive` from the DB **on every
  request**
- the `jwt` callback re-checks `passwordChangedAt` **on every call**

Deactivating an account or resetting a password therefore ends every live session
of that user immediately — a 29-day-old one included. **What lengthened is
convenience, not time-to-revoke.**

### Accepted cost

A session cookie lifted off an unlocked or lost device is replayable for up to
**7 idle days instead of 4 hours**. Recorded as **Known gap 0d** in
`docs/SECURITY.md` rather than left to be rediscovered in a later audit.

The change does make deactivate-or-reset the *only* timely lever, where
previously waiting four hours was also one. The consequence belongs in staff
onboarding, not in code: **report a lost device**, because it will not sign
itself out today.

## Design

### 1. Session timers

Two constants in `src/lib/session-freshness.ts`. **No logic changed** — `authAt`,
`lastActiveAt`, the `iat` backfill and the clock-skew guard are untouched.
`session.maxAge` in `src/auth.ts` already reads `SESSION_MAX_AGE_SECONDS`, so the
cookie can never expire before the claim it carries.

Existing sessions pick up the new window on their next request; the deploy signs
nobody out.

### 2. Home-screen install

- `src/app/manifest.ts` — `display: standalone`, `start_url: "/"`, ledger palette
  (`theme_color` `--primary`, `background_color` `--bg`).
- `src/app/icon.tsx` (512) and `src/app/apple-icon.tsx` (180) — **generated** via
  `next/og` `ImageResponse` rather than checked in as binaries, so retuning the
  palette retunes them.
- `src/app/layout.tsx` — `appleWebApp` metadata, `themeColor` on the viewport.

`start_url` is `/` deliberately: it is the one page outside the PIN gate and the
page that explains what the app is, so the icon works for a recipient as well as
a technician.

**No service worker, no offline cache.** Every page is a Server Component reading
live custody data; a cached property book would show yesterday's holder for a
device, which is worse than an error. Recorded in `CLAUDE.md` §4c so it is not
added later as a PWA-checklist reflex.

#### `mobile-web-app-capable`

Next 16 emits the **standardised** `mobile-web-app-capable` and has dropped the
Apple-prefixed name as deprecated (confirmed in the rendered `<head>`, and in
`node_modules/next/dist/docs/.../generate-metadata.md`). Recent iOS accepts that,
or the manifest's own `display: standalone`; **older iPhones read only
`apple-mobile-web-app-capable`**. `layout.tsx` adds it explicitly alongside — a
deliberate duplicate, because it is one tag and the failure it prevents is
silent.

### 3. Proxy matcher (the part that made the manifest work at all)

`/manifest.webmanifest`, `/icon` and `/apple-icon` were matched by the proxy, and
the coarse login gate redirects **any** matched path to `/login` when there is no
session. A logged-out iPhone doing "Add to Home Screen" was therefore handed
login-page HTML where it expected JSON and a PNG. Nothing errors — the install
just quietly falls back to a screenshot icon in a Safari-chrome window, which is
why it needs a test rather than a look.

They now join `favicon.ico`, which was already excluded for the same reason.

This does **not** weaken the idle clock the way narrowing the matcher normally
would. That hazard (`CLAUDE.md` §4b) is about excluding routes people *work on*,
since `lastActiveAt` only advances on matched requests. Nobody navigates to an
icon.

## Testing

- `session-freshness.test.ts` / `auth.session.test.ts` — the literal constants are
  re-pinned as an independent oracle. Two fixtures changed *meaning* and were
  rewritten rather than retuned: a pre-deploy cookie idle 5 hours now **keeps**,
  so the idle case moved to 8 days and the absolute case to 40.
- `proxy.test.ts` — a new block pins the three exclusions in the matcher string,
  keeps `favicon.ico` pinned alongside them, and asserts `/icons`, `/iconography`
  and `/apple-icons` are still matched (segment anchoring).
- `tests/e2e/auth.spec.ts` — unchanged in substance; it is the only thing that can
  see the cookie actually being re-issued across a navigation.

### Verified beyond the suite

Against a production build, with no cookies: `/manifest.webmanifest` → 200
`application/manifest+json`; `/icon`, `/apple-icon` → 200 `image/png`; `/items`
and `/admin` → **307 → `/login`**. The rendered `<head>` carries the manifest
link, the apple-touch-icon and both capable tags, and the generated PNG is a
valid 180×180 that was looked at.

## Docs changed in the same commit

`docs/SECURITY.md` (§2 rewritten, Known gap 0d added, *Last reviewed* bumped),
`CLAUDE.md` §4b plus a new §4c, and a user-facing `CHANGELOG.md` entry.
