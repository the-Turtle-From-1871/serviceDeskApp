# Gmail refresh-token rotation (local, Windows)

**Date:** 2026-07-31
**Status:** Approved, in implementation
**Relates to:** `2026-07-31-gmail-oauth-sender-design.md` (§9 Testing-status expiry)

## 1. Problem

The OAuth consent screen for `dcsim-hand-receipt` stays in **Testing** status by owner
decision. Google issues refresh tokens expiring in **7 days** to Testing-status projects
requesting non-basic scopes, and `gmail.send` is not a basic scope. When the token dies,
`getEmailSender()` falls through and outbound mail stops.

**A refresh token cannot be renewed programmatically.** The 7-day clock is attached to the
consent *grant*, not the token string; `grant_type=refresh_token` mints an access token and
does not extend the grant. Recovering requires a new authorization.

**Whether that authorization needs a human click is an open question, and the tool is built
to find out.** Google's two documents disagree for the client type in use here:

- The **web-server** doc states a `refresh_token` is only re-issued for an
  already-granted client when `prompt=consent` is sent — and that parameter is precisely
  what forces the consent screen to render.
- The **native-app** doc states refresh tokens are *always* returned for installed
  applications, and mentions neither `access_type` nor `prompt`.

This project uses a Desktop (installed-app) client. If the native-app doc governs, an
already-granted client can be re-authorized with no consent screen and no click, and
rotation is fully unattended. The countervailing unknown is whether Testing status's 7-day
expiry retires the *grant* as well as the *token* — if it does, consent re-renders.

Documentation cannot settle this; only a live rotation can. So `Get-GoogleRefreshToken`
attempts the **silent path first** (§6) and records which path succeeded.

### SETTLED (2026-08-10): the silent path does not work, under either status

**`prompt=none` is refused, and it would not have helped even if it were granted.**

Tested twice more on 2026-08-10 after the consent screen was **published** (§3, exit 1),
the second time against a grant minted three minutes earlier with the browser signed in —
the best conditions the silent path will ever get. Google returned `interaction_required`
both times, exactly as under Testing status. Not `account_selection_required` or
`login_required`, either of which would have implicated account ambiguity and been fixable
with a `login_hint`.

The deeper reason it was a dead end regardless: Google mints a refresh token only on a
**fresh grant**. For an already-authorized client it returns an access token with no
`refresh_token` at all — the case `Get-GoogleRefreshToken` throws on (§6, "NO refresh_token").
So a silent attempt could only have succeeded into a response with nothing to rotate.
**Keep the attempt anyway**: it costs under a second and it is the thing that would notice
if Google ever changes this.

This is now largely moot — publishing removes the 7-day expiry, so there is no rotation to
make clickless. See §3.

**Historical (Testing status).** The consent click was permanent while the screen stayed in
Testing.

The second rotation ran on 2026-08-10 with a live grant in place from 2026-08-04 and the
browser holding a Google session — the exact conditions the silent path needed — and
`prompt=none` still refused, in under a second, exactly as it had on the first attempt.
`UsedSilentPath` is `false`. That means Testing status's 7-day expiry retires the **grant**,
not merely the token, so there is never an already-granted client for Google to
auto-approve. The native-app doc does not govern here; the answer is the same as the
web-server doc's.

The first rotation (2026-08-04) also used the consent path but proved nothing on its own —
no grant existed yet, so `interaction_required` was the only answer Google could have
given. It did confirm the silent attempt is *cheap*: sub-second, costing nothing, exactly
as the `prompt=none` design intended. **Keep the silent attempt** for that reason — it
costs a second per rotation and starts working by itself the day the consent screen is
published (§3, exit 1), which is now the only thing that removes the click.

What is settled either way: automating the click by driving a browser through Google
sign-in is out of scope and will not be built (§2).

Automating the click by driving a browser through Google sign-in is out of scope and will
not be built: Google blocks automated browsers on `accounts.google.com`, it breaches
Google's ToS, and it requires the account password and a 2FA bypass stored on the
workstation.

## 2. Goals / non-goals

**Goals**

- Reduce rotation to at most a single consent click, roughly every 3 days. (The silent
  path in §1/§6 was the hoped-for route to no click at all; it is settled as unavailable
  under Testing status, so the one click stands until the consent screen is published.)
- Everything else automated: token exchange, Vercel env update, production redeploy.
- Escalating, unmissable notification as expiry approaches.
- No new npm or PowerShell dependencies — in-box .NET and `Invoke-RestMethod` only.
- Secrets never in the repo and never in plaintext on disk.

**Non-goals**

- Driving a browser through Google sign-in or clicking consent programmatically. Google
  blocks automated browsers on `accounts.google.com`, it breaches Google's ToS, and it
  would require the account password and a 2FA bypass stored on the workstation. This is
  forbidden regardless of what §1's silent path turns out to do.
- Changing the app's mail transport (that is the sender design).
- Fixing `.mil` deliverability.
- Any cross-platform support. This is one Windows workstation.

## 3. The two exits from this treadmill

Recorded so the cost stays visible, per the sender design's §2 precedent:

1. **Publish the consent screen.** Free, one click, removes the 7-day rule permanently.
   Declined by the owner on 2026-07-31 — **then TAKEN on 2026-08-10.** The screen is
   published; production carries a refresh token minted after that change. If it is still
   sending mail on **2026-08-18** the 7-day expiry is gone and this entire tool should be
   uninstalled (`setup.ps1 -Uninstall`) rather than left running. Until that date, do not
   rotate: rotating mints a fresh token and resets the clock, which destroys the only
   evidence that settles it. `Check` mode never rotates by itself, so its 3-day toasts can
   be ignored through 2026-08-17.
2. **Google Workspace on `dcsim.us`.** A service account with domain-wide delegation needs
   no refresh token and no consent screen, ever — genuinely unattended — and produces
   `d=dcsim.us` DKIM alignment, the one lever the sender design §2 identifies as capable of
   changing `.mil` delivery. ~$7/month.

This tooling is a deliberate third choice with an ongoing manual cost.

## 4. Scheduling

The task runs **every 6 hours**, not every 3 days. A hard 3-day trigger misses its window
when the machine sleeps and fails silently. The script decides from recorded token age:

| Age | Action |
| --- | --- |
| < 3d | exit 0, silent |
| 3–5d | toast, normal priority: rotation due |
| 5–7d | toast, urgent: mail stops in ~Xh |
| > 7d | toast, critical: outbound mail is DOWN |

Same cadence in practice, self-healing after downtime, escalating rather than silent.

## 5. Layout

`scripts/gmail-token-rotation/` — committed to the repo so it is reviewable and backed up.
Secrets live outside the tree (§7).

| File | Responsibility |
| --- | --- |
| `Common.psm1` | Config load/save, state load/save, rolling log. Shared contract. |
| `GoogleOAuth.psm1` | PKCE, loopback capture, code→token exchange. Knows nothing of Vercel. |
| `VercelApi.psm1` | Env var upsert, deploy hook, deployment polling. Knows nothing of Google. |
| `WindowsIntegration.psm1` | Toast, protocol handler, scheduled task, Start Menu shortcut. |
| `rotate-gmail-token.ps1` | Orchestrator. `-Mode Check\|Rotate`, `-DryRun`, `-Verify`. |
| `setup.ps1` | One-time install: collect secrets, register task + handler + shortcut. |
| `README.md` | Console prerequisites, recovery, uninstall. |

## 6. Rotation flow

Authorization is attempted twice, silent first (§1):

1. **Silent attempt.** Generate a PKCE verifier/challenge and a `state` nonce, bind
   `System.Net.HttpListener` to `http://127.0.0.1:<ephemeral port>/`, and open the default
   browser to Google's auth endpoint with `access_type=offline` and **`prompt=none`**. If
   Google auto-approves an already-granted client the redirect lands in about a second and
   no human is involved.
   `prompt=none` rather than simply omitting `prompt`: omitting it means "show UI only if
   needed", so a lapsed session cookie parks the tab on a sign-in page that never redirects
   and burns the whole budget. `prompt=none` means "never show UI", so a negative answer
   comes back immediately as `interaction_required` / `login_required` /
   `consent_required` / `account_selection_required`. Those four are **expected outcomes,
   logged at INFO, not errors** — they are the normal case if the grant has been retired.
   The wait is capped at 10 seconds purely as a backstop against no answer at all.
2. **Consent fallback.** If the silent attempt times out, is denied, or yields a code whose
   exchange carries no `refresh_token`, repeat with **`prompt=consent`** and the full
   timeout budget. This attempt uses a **fresh** nonce, PKCE pair and listener port — never
   the silent attempt's. A human clicks Allow.
3. Either way the listener captures `code`, validates `state` against the nonce
   (case-sensitively; a mismatch throws), and serves a confirmation page asking the user to
   close the tab. It does not self-close: `window.close()` is blocked for a tab the script
   did not open.
4. Exchange code + verifier at `https://oauth2.googleapis.com/token`.

Which path succeeded is logged and returned as `UsedSilentPath`. That log line is the
evidence that resolved §1 — it read `false` on both the first and the second rotation, so
the silent step is now a cheap standing bet on the consent screen being published rather
than an open question.

**Identifying our own deployment — verified against the live API on 2026-08-04.** The
deploy hook returns a *job* id that is not a deployment id and cannot be looked up, so
`Wait-VercelDeployment` matches `meta.deployHookId` against the hook URL's last path
segment. That field is real but undocumented, so it was written as a preference with a
timestamp heuristic behind it. The first live rotation logged `matched our deploy hook id`
and the fallback never fired, confirming the assumption. The heuristic remains as a
backstop should Vercel stop populating the field.
6. **Validate before touching production:** abort unless the response carries a
   `refresh_token` and a `scope` containing `gmail.send`.
7. Upsert `GMAIL_REFRESH_TOKEN` in the Vercel project, target `production`.
8. Fire the deploy hook.
9. Poll for the resulting deployment until `READY` / `ERROR` / `CANCELED`, 10-minute cap.
10. Persist state, append to the log, toast the outcome.

Steps 7–9 run only after step 6 passes, so a cancelled or failed consent leaves production
untouched. There is no partial-write path: the env var is written once, then the redeploy is
triggered, and a failure between them is reported as such — the next run is idempotent.

## 7. Secret handling

`%LOCALAPPDATA%\dcsim-gmail-rotation\config.xml`, written with `Export-CliXml`. Every
secret member is a `SecureString`, so it is DPAPI-encrypted and bound to this Windows user
on this machine — the file is useless if copied elsewhere.

| Key | Type | Notes |
| --- | --- | --- |
| `ClientId` | string | Desktop-app OAuth client. |
| `ClientSecret` | SecureString | |
| `VercelToken` | SecureString | Account-wide; see §9. |
| `VercelProjectId` | string | |
| `VercelTeamId` | string or `$null` | `$null` for a personal account. |
| `DeployHookUrl` | SecureString | The URL embeds a secret key. |
| `EnvVarName` | string | Default `GMAIL_REFRESH_TOKEN`. |
| `EnvTarget` | string | Default `production`. |

State at `state.json`, written atomically via a temp file and replace so a crash mid-write
cannot leave a truncated or zero-byte file: `lastSuccessAt`, `lastAttemptAt`, `expiresAt`,
`lastResult`, `lastError`, `lastDeploymentUrl`. Log at `rotate.log`, rolling at 1 MB × 3.

**`lastSuccessAt` and `lastAttemptAt` are separate, and must stay separate.** A failed
attempt moves only the attempt stamp; the success stamp, the expiry and the deployment URL
carry forward untouched, and token age is measured from `lastSuccessAt` alone. Collapsing
them into one field means a single cancelled consent makes the tool report "outbound mail
is DOWN" every six hours forever, on a token with days of life left — a false alarm on a
benign path, which is the fastest way to teach an operator to ignore the notification this
tool exists to deliver.

**No secret is ever written to the log, the state file, the console, or a toast.** The log
records that a token was obtained, never its value.

## 8. Google Console prerequisite

A **Desktop app** OAuth client is required — installed-app clients accept loopback redirects
on an arbitrary port, which is what allows automatic code capture. The client at
`Downloads\desktop app credentials.json` (`redirect_uris: ["http://localhost"]`) satisfies
this. The separate web-application client is not used by this tooling.

Both credential files hold live secrets and are deleted once `setup.ps1` has stored the
values. The desktop client secret is rotated, having been exposed in a session transcript.

## 9. Risks

| Risk | Disposition |
| --- | --- |
| Automatic redeploy ships whatever is on `main` at that moment | The repo's migrate-before-push rule assumes a human at deploy time. An unattended redeploy ~3 days after a merge could deploy code whose migration was never applied. Documented in `DEPLOY.md`; accepted. |
| Vercel API token is account-wide | Vercel personal tokens cannot be scoped to one project; this token can modify or redeploy anything in the account. Created with no expiry, deliberately — an expiring token trades one treadmill for two. Stored DPAPI-encrypted. Added to `docs/SECURITY.md`. |
| Owner ignores the toast | §4 escalation, ending in an explicit "mail is DOWN" state. The sender's own `invalid_grant` mapping (sender design §7) is the backstop in Vercel logs. |
| A rotation lands mid-send | An in-flight send uses the old access token, which stays valid for its remaining lifetime; the redeploy does not revoke it. No mitigation needed. |
| Consent click automated by a future contributor | Explicitly forbidden in §1 and in `README.md`. |

## 10. Verification

`-Verify` checks config completeness, Vercel reachability, that the target project and env
var resolve, and that the scheduled task is registered — without minting a token.

`-DryRun` performs the full OAuth flow and validation, then reports the intended Vercel
mutation and redeploy without issuing either.

Module-level: `GoogleOAuth.psm1` and `VercelApi.psm1` are independently exercisable, since
neither references the other.

## 11. Documentation obligations (same commit)

- `scripts/gmail-token-rotation/README.md` — setup, recovery, uninstall.
- `DEPLOY.md` — the unattended-redeploy interaction with migrate-before-push (§9).
- `CHANGELOG.md` — under `## 2026-07-31`, **Added**, with a **Notes** subsection covering
  the Google Console prerequisite and the Vercel token.
- `docs/SECURITY.md` — new workstation-resident credentials and their storage; bump
  *Last reviewed*.
- `scripts/check-security-docs.mjs` — add `scripts/gmail-token-rotation/` to `WATCHED` so
  the credential handling cannot change without the security doc changing.
