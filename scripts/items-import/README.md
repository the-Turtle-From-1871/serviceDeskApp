# Items CSV import (direct push from a workstation)

Imports the newest `items*.csv` sitting in the Downloads folder straight into the
app via `POST /api/items/import` (`DEPLOY.md` §7), then deletes it. Runs by hand,
or unattended as a Scheduled Task.

This is the **direct push**, and it is the path `scripts/drive-upload/README.md`
tells you to prefer. That Drive relay exists only because the government
workstation producing the export cannot reach the app at all — its web filter
refuses the domain. On a workstation that *can* reach it, this is simpler: no
service account, no key file, no public link, and none of accepted risk **0g**.

| | This script | `scripts/drive-upload/` |
|---|---|---|
| Reaches the app directly | yes | no — relays via Drive |
| Credential | one bearer secret | Google service-account key |
| Export sits on a public URL | no | yes (accepted risk 0g) |
| Latency | ~5 minutes | next scheduled Drive sweep |

## Files

| File | Purpose |
|---|---|
| `Import-ItemsCsv.ps1` | The worker. Manual runs and the Scheduled Task both use it. |
| `Setup-ImportTask.ps1` | One-time: store the secret, register/unregister the task. |
| `Run-Hidden.vbs` | 3-line shim so the recurring task shows no console window. |

Nothing is stored in this repository. Runtime state lives in
**`C:\ops\items-import\`**:

| File | Contents |
|---|---|
| `secret.txt` | `MDM_IMPORT_SECRET`, DPAPI-encrypted to one Windows account |
| `import.log` | One line per run — see [The log](#the-log) |

## The one rule that matters

**The CSV is deleted on exactly one outcome: an HTTP `200` whose body parsed as
JSON with integer `added`, `updated` and `unchanged`.** Every other outcome —
`401`, `400`, `500`, a redirect, a network failure, a `200` that isn't an import
summary — leaves the file in place, so the next poll retries it.

That last case is not hypothetical. `/api/items/import` is excluded from the
proxy matcher (`src/proxy.ts`) on purpose; the comment there spells out that
without the exclusion the coarse login gate 302s the machine POST to `/login`,
and PowerShell follows redirects by default, so the redirect comes back as a
**`200` carrying login-page HTML** — "a scheduled job that logs success while
importing nothing." Since this script deletes on success, that would also destroy
the export. Hence two guards: `-MaximumRedirection 0`, and the response-shape
check before the file is touched.

## One-time setup

1. **`MDM_IMPORT_SECRET` must already be set in Vercel** (Production, and Preview
   if you'll use it there), and the app redeployed since. Unset, the endpoint
   refuses everything with `401`. `DEPLOY.md` §7 covers generating and setting it.

2. **Prove it works before scheduling anything** — `DEPLOY.md` §7a is explicit
   that this should not go to a scheduler on day one:

   ```powershell
   .\Setup-ImportTask.ps1 -Test
   ```

   Prompts for the secret, stores it, then runs **one** import and **keeps** the
   CSV. Run it a second time: the same file should come back `added=0
   updated=0`, which confirms the import is idempotent (§7a step 3).

3. **Schedule it:**

   ```powershell
   .\Setup-ImportTask.ps1
   ```

   Registers **`InventoryApp Items CSV Import`** — every 5 minutes indefinitely,
   and again at each logon — then **runs it once and reports whether it actually
   launched**. Change the cadence with `-IntervalMinutes 15`.

   That last step matters: registering a task always succeeds, and a task that
   registers cleanly but is refused at launch looks completely healthy in the
   Task Scheduler UI. If setup warns about `0x800710E0`, see
   [Troubleshooting](#troubleshooting) — the importer itself is fine, only the
   scheduling is blocked.

Remove it later with `.\Setup-ImportTask.ps1 -Unregister` (the task goes; the
secret and log stay).

## Manual use

```powershell
# Dry run — finds the file, runs every guard, sends nothing:
.\Import-ItemsCsv.ps1 -WhatIf

# Import the newest items*.csv and delete it:
.\Import-ItemsCsv.ps1

# Import but keep the file:
.\Import-ItemsCsv.ps1 -KeepFile

# One specific file:
.\Import-ItemsCsv.ps1 -CsvPath 'C:\Users\xAdmin\Downloads\items (3).csv'
```

Every parameter falls back to an environment variable or a sensible default, so
the scheduled action needs no arguments beyond `-Quiet`:

| Parameter | Falls back to |
|---|---|
| `-Secret` | `$env:MDM_IMPORT_SECRET`, then `C:\ops\items-import\secret.txt` |
| `-BaseUrl` | `$env:INVENTORY_APP_URL`, then `https://www.dcsim.us` |
| `-DownloadsPath` | The shell's Downloads known folder, then `$env:USERPROFILE\Downloads` |
| `-Pattern` | `items*.csv` |

**Exit codes:** `0` = imported, or nothing to do. Non-zero = a real failure — so
a red *Last Run Result* in Task Scheduler means something.

## Why it polls instead of watching the folder

Because the file is deleted after a successful import, **the presence of any
`items*.csv` is itself the "something new arrived" signal**. No hash tracking, no
state file, and no resident `FileSystemWatcher` that can die silently and stop
importing with nothing reporting a problem. A poll that finds nothing makes no
network request at all and exits in milliseconds.

`items (1).csv`, `items (7).csv` and friends are all matched; the newest by write
time wins.

## Checks made before anything is sent

Each fails on the workstation, where somebody is watching, rather than in a log
the next morning:

- **A download in flight** — a sibling `items*.crdownload` / `.part` / `.csv.tmp`
  exists. Waits for the next poll.
- **The file is locked** — it won't open with `FileShare::None`, so a browser is
  still writing it. Waits.
- **The file is 0 bytes.** Waits.
- **Over 5,000,000 bytes** (`MAX_CSV_BYTES` in the route) — refuses locally.
- **The header doesn't mention a serial column** — warns but still sends. Header
  naming is flexible, the server's `400` is authoritative, and a file the server
  refuses is never deleted.

The first three exit `0` deliberately: they resolve themselves, and on a
5-minute cadence painting *Last Run Result* red for them just teaches you to
ignore it.

## The log

`C:\ops\items-import\import.log`, trimmed to the last 500 lines. **Once the CSV
is deleted, this and the app's `ImportBatch` row are the only record of what was
sent** — skipped rows and make/model mismatches are written out per row.

```
2026-08-11T08:04:12-04:00  items.csv  269468 bytes  added=3 updated=118 unchanged=1876 skipped=1 mismatches=1  deleted
    skipped row 47 (SN-004821): missing make/model on a new device
    make/model mismatch: SN-001177
```

## Design notes worth keeping

**The secret is not in the repo, and won't be.** `scripts/` is committed and
pushed to GitHub, and `MDM_IMPORT_SECRET` authenticates a **write** endpoint into
the production property book. `Setup-ImportTask.ps1` stores it DPAPI-encrypted
under `C:\ops\`, so you set it once and never touch it again — and a copied
`secret.txt` is useless on another machine or under another account.

**The task runs Interactive, not S4U.** S4U would also run while logged off with
no stored password, but it needs an elevated shell to register and is not
expected to reach the user's DPAPI master key — which would leave the secret
undecryptable. Interactive stores no password either, and nothing is lost: the
event this reacts to is *you downloading a file*, which requires you to be logged
on anyway.

`-LogonType S4U` is available as an escape hatch if Interactive tasks are refused
on your machine. It must be registered from an **elevated** prompt, and if
imports then fail with *"Could not decrypt"*, set `MDM_IMPORT_SECRET` as a
machine environment variable instead — the worker prefers the environment
variable over the encrypted file.

**Two triggers, not one.** An `-AtLogOn` trigger does not fire when the task is
registered — it fires at the *next* logon, and its repetition only starts when
the trigger itself fires. Alone, it would leave the whole cycle dormant until the
next sign-in while the task looked healthy. A `-Once` trigger starts the
repetition immediately; the logon trigger restarts it cleanly afterwards.
`MultipleInstances IgnoreNew` makes the overlap harmless. (Symptom of getting
this wrong: `NextRunTime` is blank.)

**Hence `Run-Hidden.vbs`.** An Interactive task flashes a console window on every
run — 288 times a day at 5-minute polling. `WScript.Shell.Run(cmd, 0, True)`
never creates a visible window, and returning its exit code through
`WScript.Quit` keeps *Last Run Result* honest.

**Windows PowerShell 5.1 throughout** — no ternary, no `??`, no `&&`/`||`. In
particular the multipart body is built by hand, because **`Invoke-RestMethod
-Form` does not exist before PowerShell 6.1**; the example in `DEPLOY.md` §7 is
PowerShell 7 only.

## Know this before you schedule it

**The import overwrites hand edits.** For a device already in inventory, the CSV
is treated as the source of truth for its name, home unit, category and assigned
user (`DEPLOY.md` §7). Automating the import means every export dropped in
Downloads silently reverts anything corrected in the app since the last one.

**Nothing is ever deleted from inventory.** A device missing from the export is
left untouched, not retired — absence from the CSV is not a signal.

**2000 rows maximum** per import. A larger export returns `400`; split it.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `401 Unauthorized` | The stored secret doesn't match Vercel's, or it was changed there without a redeploy. Re-run `Setup-ImportTask.ps1 -Secret '<value>'`. |
| `Could not decrypt secret.txt` | It's DPAPI-encrypted to one account. Re-run setup as the account the task runs as. |
| `400` naming a row | The server's own message — a bad row, no `serialNumber` column, or over 2000 rows. The file is kept. |
| `The server redirected (302)` | `/api/items/import` lost its exclusion in `src/proxy.ts`'s matcher. |
| `200 but not an import summary` | Same root cause, one step further along — login-page HTML came back as a 200. The file is kept. |
| Setup warns **`0x800710E0`** ("the operator or administrator has refused the request") | The task is configured correctly but Windows will not launch a process for it in your session. Seen on **RDP sessions**, and caused by endpoint security / Group Policy or a denied *Log on as a batch job* right. Task Scheduler's history shows the instance *launched* (event 110) with no action-start (event 200). Confirm it is environmental by creating a throwaway task that just runs `cmd.exe /c echo hi > C:\temp\x.txt` — if that is refused too, nothing is wrong with these scripts. Fix: run from a normal desktop session, or `-LogonType S4U` from an elevated prompt. `Import-ItemsCsv.ps1` still works by hand regardless. |
| `NextRunTime` is blank | The task has only the logon trigger, so the repetition never started. Re-run setup. |
| Task never runs on battery | `AllowStartIfOnBatteries` / `DontStopIfGoingOnBatteries` were not applied. Re-run setup. |
| Task shows Last Run Result `0` but nothing imported | Normal — that's a poll that found no file. Check `import.log` for actual runs. |
| A console window flashes | The task is invoking `powershell.exe` directly instead of `Run-Hidden.vbs`. Re-run setup. |
| Same file imported repeatedly | The delete failed (file locked / read-only). The script exits non-zero and says so; check `import.log`. |
| Rows skipped as **`duplicate in file`** | The export lists the same serial more than once. The importer keeps the **first** occurrence and skips the rest, so nothing is lost — but if the duplicate rows disagree, the first one silently wins. Fix it in the export; the app cannot tell which row is right. The August 2026 export had 28 of these out of 1,068 rows. |
| `Could not tighten permissions … SeSecurityPrivilege` | Only expected if the state folder exists but was never locked down. A folder already restricted is skipped, so this should not appear on a normal re-run. |
