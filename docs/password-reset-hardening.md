# Password-reset hardening (2026-07-13)

Follow-up to the code review of the self-service forgot/reset-password feature
(commits `81dce9b` + `7478e8e`). This document records what was changed, how it
was verified, and the decisions still owed to a human.

## Scope

Reviewed diff: `git diff c73c56d...HEAD`. The feature itself was sound
(hash-only token storage, single-use + expiry, `server-only` on the sensitive
libs, generic responses). The items below are hardening fixes, not a rewrite.

## Fixes applied

All work was split across independent, non-overlapping files so it could be done
in parallel without conflicts. Findings are numbered as in the review.

| # | Finding | Fix | File(s) |
|---|---------|-----|---------|
| 1 | No rate limiting → email-bombing / targeted reset-denial | Per-account 60s cooldown before issuing a new token (`RESET_COOLDOWN_MS`); combined with #7 this stops an attacker from killing a victim's in-flight link | `src/app/actions/auth.ts` |
| 2 | Timing side-channel defeats the anti-enumeration claim | Account lookup + token creation + email send moved off the response path via Next's `after()` (confirmed stable `import { after } from "next/server"` for Next 16 from `node_modules/next/dist/docs`); the action now returns generic success in ~constant time | `src/app/actions/auth.ts` |
| 3 | `appBaseUrl()` returned `""` → broken relative reset link | Build the URL from the shared `defaultBaseUrl()`; if no origin is configured, log server-side and **skip** the send instead of emailing a dead relative link | `src/app/actions/auth.ts` |
| 5 | Reset didn't re-check `isActive` | `resetPasswordWithToken` now loads `user.isActive` and refuses to mutate a deactivated account's password | `src/lib/password-reset.ts` |
| 6 | Non-atomic check-then-consume (TOCTOU) | Token is now **atomically claimed** with a guarded `updateMany({ where: { id, usedAt: null } })` compare-and-set; the password write proceeds only if `count === 1`, so concurrent uses of one token can't both win | `src/lib/password-reset.ts` |
| 7 | Email-send failure orphaned the reset after killing the prior token | `createPasswordResetToken` no longer pre-invalidates prior unused tokens. Multiple concurrent single-use, 1-hour links may coexist; a successful reset still invalidates all of them at consume time | `src/lib/password-reset.ts` |
| 9 | Reset password hashed without a Zod schema (CLAUDE.md §4) | `resetPasswordAction` validates via the shared `passwordField` Zod schema | `src/app/actions/auth.ts`, `src/modules/users/users.schema.ts` |
| 10 | `reset-token.ts` missing `import 'server-only'` (CLAUDE.md §4) | Added the marker as the first line | `src/lib/reset-token.ts` |
| 11 | `appBaseUrl()` duplicated `defaultBaseUrl()` | Extracted the single helper to `src/lib/base-url.ts`; both `qr.ts` and the auth action import it | `src/lib/base-url.ts` (new), `src/modules/items/qr.ts`, `src/app/actions/auth.ts` |
| 12 | Hand-rolled email validation weaker than the Zod field | `requestPasswordResetAction` validates via the shared `emailField` Zod schema | `src/app/actions/auth.ts`, `src/modules/users/users.schema.ts` |
| 13 | `escapeHtml` hand-rolled inline; missing `'` escape | Moved to `src/lib/email.ts` as an exported, `'`-escaping helper; the email module imports it | `src/lib/email.ts`, `src/modules/auth/send-password-reset-email.ts` |

New reusable exports introduced:
- `src/lib/base-url.ts` → `defaultBaseUrl()`
- `src/modules/users/users.schema.ts` → `emailField`, `passwordField` (also now reused by `newUserSchema`)
- `src/lib/email.ts` → `escapeHtml()`

New tests: `src/lib/password-reset.test.ts` (expired / used / inactive / happy-path
atomic-claim / lost-race coverage).

## Verification

- Typecheck (`tsc --noEmit`): no errors in any touched file. (One pre-existing,
  unrelated implicit-`any` error in `src/modules/transfers/transfers.service.test.ts`
  exists on clean `HEAD` and was left as-is.)
- Lint (`eslint`): 0 errors (only pre-existing unused-param warnings in tests).
- Unit tests: 13/13 pass across `password-reset`, `reset-token`,
  `send-password-reset-email`, and the two `qr` suites.
- Not run: full `next build` and the DB-backed integration/e2e suites.

## Second pass — session invalidation + token exposure (DONE)

### #4 — A password reset now invalidates existing sessions
Chose option **(a)**. Added a nullable `User.passwordChangedAt` (migration
`20260713150502_user_password_changed_at`). `resetPasswordWithToken` stamps it
(`= new Date()`) atomically with the new hash. The Auth.js `jwt` callback
(`src/auth.ts`, now `async`) seeds a `pwdChangedAt` claim from the DB at sign-in,
and on every later `auth()` call re-reads `passwordChangedAt`; if the DB stamp is
newer than the token's claim (or the account was deleted) it **returns `null`**,
which clears the session cookies (verified against Auth.js v5 core + Context7).
Safe because the Next 16 proxy/middleware runs on the **Node.js runtime**
(`src/proxy.ts`), so the Prisma call in `jwt` bundles cleanly.
- **Grandfather:** tokens issued before this change (`pwdChangedAt === undefined`)
  are seeded, not revoked — they only become revocable against a *future* reset.
- **Fail-open:** the DB reads are wrapped in try/catch; a transient DB error
  returns the token unchanged so a blip never mass-logs-out users.
- **Cost:** one extra `SELECT passwordChangedAt` per authenticated request. This
  is the accepted trade-off of keeping JWT sessions while supporting revocation.
- ⚠️ **Requires the migration to be applied to prod** before deploy
  (migrate-before-push). It was written to disk only — no DB was touched.

### #8 — Reduced raw-token URL exposure
- `next.config.ts` sets `Referrer-Policy: no-referrer` on `/reset-password` and
  `/forgot-password`, so the token can't leak via the `Referer` header.
- `ResetPasswordForm.tsx` scrubs `?token=…` from the address bar on mount
  (`history.replaceState`), keeping it out of history/bookmarks. The token stays
  in the hidden field, so submission is unaffected.
- **Residual (accepted):** the initial GET still reaches server/proxy access logs
  with the token. Fully removing it would need a token→HttpOnly-cookie exchange
  with a redirect to a clean URL — intentionally deferred.

## Still owed to a human (NOT done)

### Production-grade rate limiting
The per-account cooldown handles email-bombing of a *known* address. It does
**not** provide IP-based or global throttling (enumeration probing, distributed
abuse). A real limiter (e.g. Upstash/Redis or an edge-middleware throttle) is
infrastructure and was left as a follow-up.

## Not addressed here

A new "Backend Architecture & Feature Constraints" section (ticket lifecycles,
90-day purge, DCSIM notifications, ingest/routing queue) was added to `CLAUDE.md`
by the maintainer during this session. Those are separate features, out of scope
for this password-reset hardening pass, and are left for their own work.
