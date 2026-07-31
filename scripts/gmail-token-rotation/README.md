# Gmail refresh-token rotation

Local Windows tooling that keeps `GMAIL_REFRESH_TOKEN` alive in Vercel production.

Design: [`docs/superpowers/specs/2026-07-31-gmail-token-rotation-design.md`](../../docs/superpowers/specs/2026-07-31-gmail-token-rotation-design.md).

## Why this exists

The OAuth consent screen for the `dcsim-hand-receipt` Google Cloud project is in
**Testing** status by decision. Google issues Testing-status projects a refresh token that
expires after **7 days** when a non-basic scope is requested, and `gmail.send` is not a
basic scope. When it dies, `getEmailSender()` stops using the Gmail transport and outbound
mail fails.

A refresh token **cannot be renewed programmatically** — the 7-day clock is on the consent
*grant*, not the token string, and `grant_type=refresh_token` does not extend it. Only a
fresh authorization produces a new one. This tool automates the whole of that except,
possibly, one click.

> **Do not try to automate the consent click by driving a browser through Google sign-in.**
> Google blocks automated browsers on `accounts.google.com`, it breaches Google's ToS, and
> it would require the account password and a 2FA bypass stored on this workstation. If you
> want the click gone, use one of the two exits below instead.

### Two ways to delete this tool entirely

1. **Publish the consent screen** (Google Cloud console → OAuth consent screen → Publish).
   Free, immediate, removes the 7-day rule. Verification may remain pending; publishing
   status alone governs token lifetime.
2. **Google Workspace on `dcsim.us`.** A service account with domain-wide delegation needs
   no refresh token and no consent screen ever, and produces `d=dcsim.us` DKIM alignment —
   the one lever that might also fix `.mil` delivery. ~$7/month.

## Install

You need, before starting:

| Thing | Where from |
| --- | --- |
| A **Desktop app** OAuth client id + secret | Google Cloud console → Credentials. Installed-app clients accept loopback redirects, which is what allows automatic code capture. |
| Gmail API enabled | Google Cloud console → APIs, project `dcsim-hand-receipt`. |
| A Vercel API token | Vercel → Account Settings → Tokens. Create it with **no expiry** — an expiring token trades one treadmill for two. |
| The Vercel project id | Vercel → Project → Settings → General. |
| The Vercel team id | Only if the project sits under a team. Leave blank for a personal account. |
| A Vercel Deploy Hook URL | Vercel → Project → Settings → Git → Deploy Hooks, targeting `main`. |

Then:

```powershell
cd scripts\gmail-token-rotation
.\setup.ps1
```

`setup.ps1` needs **no elevation** and will warn you if you run it elevated. It prompts for
each value, stores them encrypted, and registers the scheduled task, the protocol handler
and the Start Menu shortcut.

Verify, then seed the first token:

```powershell
.\rotate-gmail-token.ps1 -Verify
.\rotate-gmail-token.ps1 -Mode Rotate
```

Finally, **delete the credential JSON files from `Downloads`** — they contain live client
secrets — and rotate the desktop client secret in the console if it has been shared or
pasted anywhere.

## How it runs

A scheduled task fires **every 6 hours** and runs `-Mode Check`, which decides from the age
of the last successful rotation:

| Age of token | What happens |
| --- | --- |
| under 3 days | nothing, silently |
| 3–5 days | normal toast: rotation due |
| 5–7 days | urgent toast: mail stops in ~N hours |
| over 7 days | critical toast: outbound mail is DOWN |

Six-hourly rather than a flat 3-day trigger so a sleeping machine cannot miss its window,
and so the warning escalates instead of failing silently.

Click the toast (or the Start Menu shortcut) to rotate. Rotation:

1. Tries a **silent** authorization first (`prompt=none`). If Google auto-approves the
   already-granted client, there is no consent screen and no click. If it refuses, it says
   so in under a second and we move straight on — no waiting around.
2. Falls back to `prompt=consent` with a fresh nonce, PKCE pair and port if the silent
   attempt yields no refresh token. This is the path that asks you to click Allow.
3. Writes the new token to Vercel production, fires the deploy hook, waits for the build.

Which path was used is written to the log as `UsedSilentPath`. **Whether the silent path
works is currently unknown** — Google's web-server and native-app docs contradict each
other for Desktop clients. The first few rotations settle it; if the silent path holds, the
click disappears and the spec gets corrected.

Nothing in Vercel is touched until a valid token with the `gmail.send` scope is in hand, so
a cancelled consent leaves production exactly as it was. It is recorded as a failed
attempt, which keeps the reminders coming — but it does not change how urgent they are,
because the token already in production is still the one from the last success and is
still aging on its own clock.

## Commands

```powershell
.\rotate-gmail-token.ps1 -Verify        # read-only preflight; mints nothing, changes nothing
.\rotate-gmail-token.ps1 -Mode Rotate   # do it now
.\rotate-gmail-token.ps1 -Mode Rotate -DryRun   # real consent, then report instead of deploying
.\rotate-gmail-token.ps1 -Mode Check    # what the scheduled task runs
.\setup.ps1 -Uninstall                  # remove persistence
```

`-DryRun` is safe: Google permits many concurrent refresh tokens per client, so minting one
does not invalidate the token production is using.

## Where things live

| Path | What |
| --- | --- |
| `%LOCALAPPDATA%\dcsim-gmail-rotation\config.xml` | Secrets, DPAPI-encrypted, bound to this Windows user on this machine. |
| `%LOCALAPPDATA%\dcsim-gmail-rotation\state.json` | Last rotation time and result. No secrets. |
| `%LOCALAPPDATA%\dcsim-gmail-rotation\rotate.log` | Rolling log, 1 MB × 3. No secrets. |
| `%APPDATA%\...\Start Menu\Programs\DCSIM Gmail Token Rotation.lnk` | Manual launch; also carries the AppUserModelID the toasts need. |
| `HKCU\Software\Classes\dcsim-gmail-rotate` | Protocol handler the toast button activates. |
| Task Scheduler → `\DCSIM\Gmail Token Rotation Check` | The 6-hourly check. |

`-Uninstall` removes the last three and asks before deleting the config and state. The log
is always left in place — it is the record of what the tool did.

## When it goes wrong

**"No configuration at … Run setup.ps1 first."** — setup has not run, or you are signed in
as a different Windows user. The config is DPAPI-bound per user; it cannot be shared.

**Consent succeeds but Vercel fails.** The state is recorded as `failed` on purpose, so the
6-hourly check keeps nagging — production is still running the old, dying token. Re-run
`-Mode Rotate`.

**"Token was written to Vercel but the build did not finish."** The token *is* live in
Vercel; only the build went unobserved. Check the Vercel dashboard.

**Mail is down and you need it back now.** Fastest recovery is to set `GMAIL_REFRESH_TOKEN`
by hand in the Vercel dashboard and redeploy — this tool is a convenience, not a dependency.

**The scheduled task runs but no toast appears.** The task must run in the interactive
session; it is registered that way deliberately, because a hidden session can neither show
a toast nor open a browser. Re-run `setup.ps1` to re-register, and check
`Get-RotationIntegrationStatus`.

## A caveat worth knowing

Every rotation triggers a **production redeploy from `main`**, unattended. This repo's
migrate-before-push rule assumes a human is present at deploy time. If someone merges code
that needs a migration and does not apply it, this task will deploy that code up to ~3 days
later with nobody watching. See `DEPLOY.md`.
