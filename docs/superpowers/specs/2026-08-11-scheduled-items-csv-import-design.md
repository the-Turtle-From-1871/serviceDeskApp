# Scheduled `items*.csv` import from Downloads — design

**Date:** 2026-08-11
**Status:** approved

## Problem

The MDM fleet export lands in `C:\Users\xAdmin\Downloads` as `items.csv` — or
`items (1).csv`, `items (2).csv`, … because the browser refuses to overwrite an
existing download. Today it is imported by hand through `/admin/items/import`.

This workstation is **not** a government laptop, so it can reach the app
directly. The Drive relay in `scripts/drive-upload/` exists only because the
*exporting* workstation cannot, and `scripts/drive-upload/README.md` already says
to prefer the direct push (`DEPLOY.md` §7) wherever it is possible. Here it is
possible, so this uses `POST /api/items/import` and no Drive round trip.

## Goals

- Import the newest `items*.csv` from Downloads automatically, with no
  interaction.
- Provide the same thing as a manual command, for one-off imports and for the
  "prove it before you schedule it" step in `DEPLOY.md` §7a.
- Never import a partially-downloaded file.
- Never delete a file that was not actually imported.

## Non-goals

- Watching Drive, or any change to the existing `scripts/drive-upload/` path.
- Any change to the import endpoint, `commitImport`, or the app itself. This is
  ops tooling only.
- Retrying a failed import automatically. A failure leaves the file in place, so
  the next poll retries it naturally.

## Two facts that constrain the implementation

Both were verified rather than assumed, and both silently break a naive version.

**1. `Invoke-RestMethod -Form` does not exist on Windows PowerShell 5.1.** It was
added in PowerShell 6.1. This machine runs 5.1
(`$PSVersionTable.PSVersion` = 5.1.26100.8655), and the example in `DEPLOY.md`
§7/§7a uses `-Form`, so that example cannot run here as written. The script
builds the `multipart/form-data` body by hand from bytes. `DEPLOY.md` is
corrected in the same commit so the next reader does not hit this.

**2. A redirect must never be followed, and a 200 is not proof of an import.**
`/api/items/import` is deliberately excluded from the proxy matcher
(`src/proxy.ts`), and the comment there records exactly why: without the
exclusion the coarse login gate 302s the machine POST to `/login`, and
`Invoke-RestMethod` — which follows redirects by default — turns that into a
**200 carrying login-page HTML**, i.e. "a scheduled job that logs success while
importing nothing."

Normally that is a hazard for the *job's* accuracy. Here it is worse, because
this script **deletes the CSV on success**: a silently-unimported file would be
destroyed. So two independent guards are required, not one:

- `-MaximumRedirection 0`, so a 3xx raises instead of being chased.
- The response must parse as JSON whose `added`, `updated` and `unchanged` are
  integers, checked before the file is touched. HTML fails this.

## Architecture

Four files in `scripts/items-import/`, following the shape of
`scripts/drive-upload/` (worker script + README, every parameter falling back to
an environment variable).

```
scripts/items-import/
  Import-ItemsCsv.ps1     the worker — manual runs and the scheduled task both use it
  Setup-ImportTask.ps1    one-time: store the secret, register/unregister the task
  Run-Hidden.vbs          3-line shim so the 5-minute task shows no console window
  README.md               setup, manual use, troubleshooting
```

State lives **outside the repo**, in `C:\ops\items-import\`:

| File | Contents |
|---|---|
| `secret.txt` | `MDM_IMPORT_SECRET`, DPAPI-encrypted to the current Windows account |
| `import.log` | One line per run; the only local record of what was sent, since the CSV is deleted |

The repo holds no credential. `C:\ops\items-import\` is ACL-restricted to the
account that runs the task.

### Why DPAPI rather than a plain file or an environment variable

The user's first instinct was to hardcode the secret in the script. That is the
one option ruled out: `scripts/` is committed and pushed to GitHub, and
`MDM_IMPORT_SECRET` is the bearer credential for a **write** endpoint into the
production property book.

DPAPI keeps the "set it once and never think about it" property intact while
making the stored file useless if copied to another machine or read by another
account. It costs the user nothing — `Setup-ImportTask.ps1` writes it — and it
is why the task runs with an **Interactive** logon type (see below).

### Detection: polling, not watching

One task, triggered at logon, repeating every 5 minutes indefinitely.

Because the file is **deleted after a successful import**, the presence of any
`items*.csv` in Downloads *is* the "something new arrived" signal. No hash
tracking, no state file, no resident `FileSystemWatcher` that can die silently.
A poll that finds nothing makes **no network request at all** and exits in
milliseconds.

### Why Interactive logon rather than S4U

Interactive stores no Windows password, and nothing is lost by "only when logged
on": the event this reacts to is the user downloading a file, which requires them
to be logged on anyway. It is therefore the default.

**Corrected 2026-08-11.** This section originally argued that S4U had to be
avoided because it could not reach the user's DPAPI master key, leaving the
secret undecryptable. That was a prediction, not a measurement, and it was
**wrong** — and wrong in the direction that mattered, because on the target
machine S4U turned out to be the *only* logon type that runs at all (see
*Verified* below). `-LogonType S4U` is the documented remedy for a machine that
refuses Interactive tasks; it needs an elevated shell to register, and it still
stores no Windows password. The machine-level `MDM_IMPORT_SECRET` environment
variable remains the fallback if some other machine genuinely cannot decrypt.

Interactive keeps DPAPI working and stores no password. Nothing is lost by it:
the event this whole thing reacts to is *the user downloading a file*, which
requires them to be logged on anyway.

The one cost of Interactive is a console window flashing every 5 minutes.
`Run-Hidden.vbs` (`WScript.Shell.Run …, 0, False`) removes it — the standard
fix, and preferable to `-WindowStyle Hidden`, which still flashes briefly.

## `Import-ItemsCsv.ps1` — flow

1. **Resolve the secret:** `-Secret` → `$env:MDM_IMPORT_SECRET` →
   `C:\ops\items-import\secret.txt`. Missing → fail with a message naming
   `Setup-ImportTask.ps1`.
2. **Resolve the CSV:** `-CsvPath` if given; otherwise the newest `items*.csv`
   by `LastWriteTime` in the Downloads folder (resolved from the shell's known
   folder registry value, falling back to `$env:USERPROFILE\Downloads`, so a
   OneDrive-redirected Downloads still works).
3. **Nothing found → exit 0, silently.** This is the normal case for ~288 of the
   ~288 daily polls. Exiting non-zero here would paint Task Scheduler's *Last
   Run Result* red permanently and train the user to ignore it.
4. **Refuse to send a file still being written** — three guards, because a
   truncated CSV would import partial rows and then be deleted:
   - a sibling `items*.crdownload` / `items*.part` / `items*.tmp` exists in the
     folder → a download is in flight;
   - the chosen file cannot be opened with `FileShare::None` → something still
     holds it;
   - the file is 0 bytes.

   Each exits **0 and quietly**: the next poll retries.
5. **Local pre-checks**, mirroring `Upload-FleetCsv.ps1` so a failure happens
   where somebody is watching:
   - over 5,000,000 bytes (`MAX_CSV_BYTES` in the route) → refuse locally;
   - header line does not mention a serial column → warn, but still send. The
     server's `400` is authoritative, and a refused file is **not** deleted.
6. **POST** hand-built multipart to `<BaseUrl>/api/items/import` with
   `Authorization: Bearer <secret>` and `-MaximumRedirection 0`.
7. **Validate the response shape** — `added`, `updated`, `unchanged` must all
   parse as integers. This is the login-page-HTML guard.
8. **Log** one line to `import.log`: timestamp, filename, bytes, the three
   counts, plus `skipped` and `mismatches` detail. Trimmed to the last 500 lines
   (only rewritten once it exceeds 600, so the common path does no rewrite).
9. **Delete the file permanently** — only after step 7 passed.

**Exit codes:** `0` = imported, or nothing to do. Non-zero = a genuine failure,
so a red *Last Run Result* in Task Scheduler means something.

**Switches:** `-CsvPath`, `-BaseUrl` (default `https://www.dcsim.us`),
`-WhatIf` (everything except the POST), `-KeepFile` (import without deleting —
for manual runs), `-Quiet` (the scheduled task's mode: log, don't write to the
console).

## `Setup-ImportTask.ps1` — one-time

- Creates and ACL-locks `C:\ops\items-import\`.
- Prompts for the secret with `Read-Host -AsSecureString`, stores it
  DPAPI-encrypted.
- Registers scheduled task **`InventoryApp Items CSV Import`**:
  - trigger: at logon, repetition every 5 minutes, indefinite duration;
  - principal: current user, `LogonType Interactive`, `RunLevel Limited`;
  - settings: `MultipleInstances IgnoreNew` (a slow 45s import cannot be
    re-entered by the next poll), `StartWhenAvailable`, 10-minute execution
    limit, and **`AllowStartIfOnBatteries` + `DontStopIfGoingOnBatteries`** —
    without both, the task silently never runs on an unplugged laptop.
- `-Unregister` removes the task; `-Test` runs one import immediately;
  `-IntervalMinutes` overrides the cadence.

## Error handling

| Case | Behaviour |
|---|---|
| No CSV present | Exit 0, no request, no log line |
| Download in flight / file locked / 0 bytes | Exit 0, quiet; next poll retries |
| Oversized locally | Exit non-zero, file kept, logged |
| `401` | Exit non-zero, file kept, message points at the secret |
| `400` (unparseable, >2000 rows, no serial column) | Exit non-zero, file kept, server's message logged verbatim |
| `3xx` | Exit non-zero, file kept — the proxy-exclusion regression |
| `200` with a non-JSON or wrong-shaped body | Exit non-zero, **file kept** |
| `500` / network failure | Exit non-zero, file kept |

The invariant: **the file is deleted on exactly one path** — a validated
200 — and every other outcome leaves it in place for the next poll.

## Testing

No unit-test harness exists for PowerShell in this repo, and adding one for four
ops scripts is not proportionate. Verification is by execution.

### Verified

| # | Check | Result |
|---|---|---|
| 1 | `-WhatIf` against the real `items.csv` (269,468 bytes) | Found it, passed every guard, sent nothing |
| 2 | Empty folder (the normal poll) | Quiet, exit 0, **no network request** |
| 3 | `.crdownload` sibling present | "a download is still in flight", exit 0 |
| 4 | 0-byte file | "is 0 bytes", exit 0 |
| 5 | File locked with `FileShare::None` | "is locked by another process", exit 0 |
| 6 | `items.csv` + `items (1).csv` | Took the newer `items (1).csv` |
| 7 | Header with no serial column | Warned, did not refuse |
| 8 | Real POST to production with a **wrong secret** | `401`, exit 1, **file kept**, logged |
| 9 | `Run-Hidden.vbs` exit-code propagation | `cscript` returned 1 from the worker's exit 1 |
| 10 | Task registration shape | Correct action, two `PT5M` triggers, Interactive/Limited, `IgnoreNew`, both battery flags, `PT10M` limit, `NextRunTime` populated |
| 11 | State-directory ACL | Inheritance removed; exactly user + SYSTEM + Administrators |

Test 8 is the important one: `items.csv` was still 269,468 bytes and untouched
after every failure path, confirming the delete-only-on-confirmed-import
invariant under real conditions.

### Verified live, against production

With the real secret in place, `Setup-ImportTask.ps1 -Test` run repeatedly:

```
added=0 updated=0 unchanged=1040 skipped=28 mismatches=0
```

identical across runs — the import is idempotent against unchanged input
(`DEPLOY.md` §7a step 3). All 28 skipped rows are `duplicate in file`; see
*Known limitation* below.

### Bugs this found, and fixed

The first two were caught by pre-flight testing; the last two only surfaced once
a real, authenticated import ran, because both live on the path *after* a
successful POST.

- **The ACL never applied.** `SecurityIdentifier('SY', $null)` binds to the
  `(byte[], int)` overload, not the SDDL-string one, and threw. Now uses
  `WellKnownSidType`.
- **The schedule would have been dormant.** An `-AtLogOn` trigger does not fire
  at registration, and its repetition only starts when the trigger fires — so
  registering while already logged on left the 5-minute cycle waiting for the
  next sign-in, with `NextRunTime` blank and the task looking healthy. Fixed by
  adding a `-Once` trigger that carries the repetition immediately.
- **`-Test` never reached the worker's `-KeepFile`.** `& $worker @('-KeepFile')`
  is *array* splatting, which passes elements **positionally**, so the literal
  string `-KeepFile` bound to the first positional parameter (`$CsvPath`) and the
  run died with `CSV not found: -KeepFile`. Only *hashtable* splatting binds by
  name. It was invisible until then because every earlier test passed `-Secret`
  explicitly, taking a different route through the argument list.
- **`.Count` threw after the import had already committed.** `Get-ResponseArray`
  returns `@($prop.Value)`, but PowerShell unwraps a single-element array on
  return — so a response carrying exactly one `skipped` row handed back a bare
  `PSCustomObject`, and an empty list collapsed to `$null`. Under
  `Set-StrictMode -Version Latest`, `.Count` on either throws
  `PropertyNotFoundStrict`. **This was the serious one:** the throw lands
  *after* the server has committed but *before* the delete, so a scheduled run
  would have left the CSV in place and re-imported it every 5 minutes forever —
  harmless to the data (every pass after the first is `added=0 updated=0`) but
  writing an `ImportBatch` row each time. Fixed by forcing array context at the
  call site.
- **The ACL warned on every run after the first.** `Set-Acl` writes back every
  section `Get-Acl` returned, including the SACL, and writing a SACL needs
  `SeSecurityPrivilege`, which a non-elevated shell lacks. Now the folder is only
  restricted when it is not already restricted.

### Scheduled execution — refused as Interactive, working as S4U

**An Interactive task cannot execute on the target machine.** Every launch
returns `0x800710E0` ("the operator or administrator has refused the request"),
on the **natural trigger** as well as on-demand, and a control task created by
`schtasks.exe` whose only action is `cmd.exe /c echo` is refused identically —
so it is environmental, not a defect in these scripts. Task Scheduler logs the
instance as *launched* (event 110) and *queued* (event 325) with no action-start
(event 200). Every queue-inducing condition was already ruled out:
`RunOnlyIfIdle`, `RunOnlyIfNetworkAvailable` and both battery flags off,
`AllowDemandStart` and `Enabled` true, power Online, Schedule service running,
user interactively logged on over **RDP** (`rdp-tcp#0`, session 3).

**Registering the same task as S4U from an elevated prompt fixed it**, and the
whole chain is now verified live:

| Step | Evidence |
|---|---|
| Task launches | `LastTaskResult` moved off `0x800710E0`; action ran |
| Secret decrypts under S4U | reached an authenticated request at all |
| Request authenticates | server answered **`400`**, not `401` |
| Bad file refused, not deleted | `FAILED HTTP 400: Missing required column(s): serialNumber.. items.csv was kept.` |
| Idle poll is silent | next cycle `LastTaskResult=0`, no log line written |

The `400` is the load-bearing detail: it can only be produced *after* the bearer
token was accepted, so it proves DPAPI decryption succeeded under S4U — which is
the opposite of what this document originally predicted. The probe CSV used for
this had no `serialNumber` column deliberately, so the run exercised the full
path while writing nothing to inventory.

`Setup-ImportTask.ps1` runs the task once after registering and reports the
outcome explicitly rather than assuming success — which is what surfaced all of
the above.

## Documentation updated in the same commit

- **`DEPLOY.md` §7** — the `-Form` example is PowerShell 7 only; state that, give
  the 5.1 alternative, and point at `scripts/items-import/`.
- **`CHANGELOG.md`** — an Added entry with a Notes subsection for the new
  `C:\ops\items-import\` location and the secret requirement.

`docs/SECURITY.md` is **not** touched: nothing here changes an authn/authz
check, the public surface, or the CI posture. The endpoint, its constant-time
secret compare and its threat model are unchanged — this is a new client of an
existing door.

## Known limitation, accepted

**The import overwrites hand edits.** For a device already in inventory the CSV
is source of truth for name, home unit, category and assigned user
(`DEPLOY.md` §7). Automating this means every export dropped in Downloads
silently reverts anything corrected in the app since the last one. Raised with
the user before implementation and accepted; recorded here so it is not
rediscovered as a bug.
