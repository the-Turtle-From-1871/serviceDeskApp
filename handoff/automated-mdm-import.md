# Automated MDM import — hand-off

**Feature:** a nightly Intune/MDM export can POST itself into the Hand Receipt app
instead of being uploaded by hand.

**Audience:** the person automating the export (sections 2–5), and whoever owns the
app (sections 1 and 6).

This document is self-contained and safe to share. It contains no secrets.

---

## 0. Quick start — do this and nothing else

If you read one section, read this one. Everything below is detail.

**Use the script in this folder: `Send-MdmImport.ps1`.** It checks for the mistakes
people actually make — missing secret, wrong file type, too many rows, whitespace
copied along with the secret — *before* sending anything, and prints a plain-English
result. Don't hand-write the request unless you have a reason to.

**Step 1 — put the secret in the environment.** Open PowerShell and run this,
pasting the value you were given between the quotes:

```powershell
$env:MDM_IMPORT_SECRET = "paste-the-secret-here"
```

**Step 2 — send the file.** From the folder holding `Send-MdmImport.ps1`:

```powershell
.\Send-MdmImport.ps1 -CsvPath C:\path\to\fleet.csv -Uri "https://www.dcsim.us/api/items/import"
```

> ⚠️ **Pass `-Uri` unless your copy of the script is dated 2026-08-04 or later.**
> The app's address is now `https://www.dcsim.us`, and the script in the
> repository defaults to it as of 2026-08-04 — but a copy taken before that
> defaults to `https://servicedeskapp.vercel.app`, which the government network
> **blocks** — so on a `.mil`-managed machine the run fails to connect rather than
> importing anything. The Vercel address still works from an unfiltered network,
> which is exactly why this is worth checking rather than assuming: it can look
> fine when you test it from home and fail on the machine that runs the schedule.
> Check yours with `Select-String -Path .\Send-MdmImport.ps1 -Pattern 'vercel\.app'`
> — any output means pass `-Uri`.

**Step 3 — read what it prints.** Green "Import succeeded" with counts means it
worked. Red "FAILED" tells you what to fix, and nothing was imported.

That's it. Do this **by hand at least twice** (see §6) before putting it on a
schedule.

> **If PowerShell refuses to run the script** — "running scripts is disabled on this
> system" — run this once in the same window and try again:
> ```powershell
> Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
> ```
> That allows scripts for this window only and changes nothing permanently.

> **Constrained Language Mode is supported.** On a machine locked down with WDAC or
> AppLocker, PowerShell blocks .NET method calls and prints *"Method invocation is
> supported only on core types in this language mode."* `Send-MdmImport.ps1` contains
> **no .NET method calls at all**, so it runs under that restriction — it prints the
> mode it detected on its second line, so paste that line in if you report a problem.
> If you see that error anyway, check your copy is current:
> ```powershell
> Select-String -Path .\Send-MdmImport.ps1 -Pattern '::','\.\w+\('
> ```
> No output means the copy is current, and the error is coming from something other
> than this script — send the whole run output, which now names the file and line.

**When you're ready to schedule it**, set the secret as a *machine* environment
variable so it survives reboots and isn't visible in the task definition:

```powershell
# Run PowerShell as Administrator, once:
setx MDM_IMPORT_SECRET "paste-the-secret-here" /M
```

`setx` is used rather than `[Environment]::SetEnvironmentVariable(...)` because the
latter is a .NET method call, which a locked-down machine refuses — see the
Constrained Language Mode note below. Open a **new** window afterwards; `setx` does
not affect the window you ran it in.

Then point a Task Scheduler action at:

```
Program:    powershell.exe
Arguments:  -NoProfile -ExecutionPolicy Bypass -File "C:\path\to\Send-MdmImport.ps1" -CsvPath "C:\path\to\fleet.csv" -LogPath "C:\path\to\import.log" -Uri "https://www.dcsim.us/api/items/import"
```

The script exits non-zero on any failure, so Task Scheduler shows a red "Last Run
Result" rather than reporting success on a broken run. **Check that column
occasionally** — it is how you find out the job quietly stopped working.

---

## 1. What it is, in one paragraph

The app exposes one endpoint that accepts a CSV of your device fleet. Send the same
file you would otherwise upload through the admin **Import** page, and it is applied
the same way: a device already in inventory is updated, a device not seen before is
added, and **nothing is ever deleted**. The whole file is applied as a single
transaction, so it either all lands or none of it does.

Nothing on the app's side reaches out to fetch anything. The scheduled job on your
end does the sending.

---

## 2. What you need before you start

| You need | Where it comes from |
| --- | --- |
| The app's URL | `https://www.dcsim.us` — **not** the old `servicedeskapp.vercel.app`, which the government network blocks |
| A secret value | The app owner generates it and gives it to you |
| Your export as a `.csv` file | Your existing Intune/MDM export |

The secret is a credential that can write to the inventory. Store it the way you
would store a password — an environment variable or a secret store, not inline in
the script, and not in email or chat.

---

## 3. Sending the file

`POST` the CSV as `multipart/form-data`, in a field named `file`, with the secret in
an `Authorization` header:

```
POST https://www.dcsim.us/api/items/import
Authorization: Bearer <secret>
Content-Type: multipart/form-data
```

> ⚠️ **`Invoke-RestMethod -Form` does not exist in Windows PowerShell 5.1**, which is
> what a stock Windows machine still runs — check yours with
> `$PSVersionTable.PSVersion`. On 5.1 the example below fails with *"A parameter
> cannot be found that matches parameter name 'Form'"*. Use `Send-MdmImport.ps1`
> from §0, which handles both versions, or the `curl` example underneath.

### PowerShell 7+ (what a scheduled task should run)

```powershell
$headers = @{ Authorization = "Bearer $env:MDM_IMPORT_SECRET" }
$form    = @{ file = Get-Item .\fleet.csv }

$result = Invoke-RestMethod `
  -Uri "https://www.dcsim.us/api/items/import" `
  -Method Post -Headers $headers -Form $form

$result | ConvertTo-Json -Depth 5
```

`Get-Item` matters — passing the path as a plain string sends the *filename* as text
rather than the file's contents.

### curl

```bash
curl -X POST "https://www.dcsim.us/api/items/import" \
  -H "Authorization: Bearer $MDM_IMPORT_SECRET" \
  -F "file=@fleet.csv"
```

---

## 4. What comes back

On success you get `200` and a JSON summary. `added`, `updated`, `unchanged`,
and `detected` are **counts** (numbers). `skipped`, `unresolved`, and
`mismatches` are **arrays** of per-row detail — `[]` when there's nothing to
report. Don't call `.length` on the first four, and don't treat the last
three as counts.

| Field | Type | Meaning |
| --- | --- | --- |
| `added` | number | New devices created |
| `updated` | number | Existing devices whose details changed |
| `unchanged` | number | Existing devices already matching the export |
| `detected` | number | Devices whose home unit was filled in or corrected automatically |
| `skipped` | array | Rows not imported, each with a reason |
| `unresolved` | array | Rows imported **but** with no home unit — see below |
| `mismatches` | array | Devices whose make/model in the export differs from what's on file |

Example body:

```json
{
  "added": 3,
  "updated": 118,
  "unchanged": 1876,
  "detected": 12,
  "skipped": [
    { "row": 47, "serialNumber": "SN-004821", "reason": "missing make/model on a new device" }
  ],
  "unresolved": [
    { "row": 203, "deviceName": "LAPTOP-WABC01-042", "segments": ["WABC01", "042"] }
  ],
  "mismatches": [
    { "serialNumber": "SN-001177" }
  ]
}
```

Other responses:

| Code | Meaning | What to do |
| --- | --- | --- |
| `401` | Missing or wrong secret | Check the header and the value. Nothing was written. |
| `400` | Not named `*.csv`, unparseable, **or more than 2000 rows** | Check the file, or split it (section 5). Nothing was written. |
| `413` | File too large | Split it. Nothing was written. |
| `500` | Unexpected failure | Log the body and tell the app owner. Nothing was written. |

**Any non-`200` means nothing was written at all.** There is no partial state to
clean up, so the correct response to a failure is always "fix and re-run", never
"work out which rows made it".

**Log the response body on every run**, not just failures. The counts are how you
notice the job silently doing nothing.

---

## 5. Behaviour worth knowing before you schedule it

- **Maximum 2000 rows per request.** A larger export must be split into several
  files. The endpoint will not chunk it for you.
- **`serialNumber` is the required column** and is how devices are matched. It is
  matched case-insensitively.
- **Nothing is ever deleted.** A device missing from the export — decommissioned,
  off the network, whatever — is left exactly as it was. Absence from the file is
  not a signal to the app.
- **The export wins on matched devices.** For a device already in inventory, the
  export is treated as the source of truth for its name, home unit, category and
  assigned user. Those values are replaced, including overwriting a correction
  someone made by hand in the app since the last run. This is intended.
- **`make`, `model` and `serial number` are never overwritten** on an existing
  device. A disagreement is reported under `mismatches` for a human to look at.
- **An unrecognised unit doesn't fail the row.** The device still imports, just with
  a blank home unit, and appears under `unresolved`. Treat that list as "needs a
  look", not "didn't import". Someone in the app can teach the abbreviation at
  **Admin → Units**, and the next export containing that device will fill it in.
- **Re-sending the same file is safe.** Only genuine changes are written, so a
  repeat run is close to a no-op.

---

## 6. For the app owner: first run, before scheduling anything

Do not point a scheduler at this on day one. Timings measured locally do not
transfer — in production the app talks to its database over the network, and that
latency is the open question.

**Prerequisites** (their absence produces a confusing failure rather than a useful
measurement):

1. The migration `20260730000000_import_service_account` is applied to the
   production database. Without it, every request returns `500`, because there is no
   account to attribute the import to.
2. `MDM_IMPORT_SECRET` is set in Vercel for **Production and Preview**. Paste it
   with no trailing newline — the comparison is byte-exact, and a stray newline
   produces a baffling `401`.
3. The code is deployed.

**Then, in order:**

1. **Dry run, writing nothing.** Open `/admin/items/import`, choose the export, click
   **Analyze**, and stop without committing. This performs the same parse and the
   same database reads as a real import. The counts show what *would* apply, and how
   long it takes is your real database latency.
2. **One manual run.** Send the file yourself using the command in section 3, then
   read the function's **actual duration** in the Vercel dashboard. That is the real
   number; everything else is extrapolation.
3. **Expect a large `updated` count on that first run.** Devices currently carrying a
   blank home unit get one filled in. That is the intended backfill, not runaway
   churn.
4. **Send the same file again.** It should come back close to a no-op, which confirms
   the import is idempotent and gives you the steady-state timing for every nightly
   run after this.
5. **Only now give the secret to the technician and let the schedule start.**

**Why it should fit comfortably:** the import is round-trip bounded, not row bounded
— a 2000-row file is roughly 15–20 database queries, not 2000, because rows are
grouped and written in batches. Database latency multiplies by about twenty, not by
two thousand. The function is allowed **60s** total; the database transaction inside
it is budgeted **45s** (`maxWait` 5s to acquire a pool connection, plus `timeout` 40s
for the transaction itself), leaving roughly **15s** outside the transaction for
reading the upload, resolving the service account, and the lookup queries that run
before the transaction opens, plus unwind time afterward. Measure it at step 2
rather than trusting this paragraph.

**If it ever does time out**, the symptom is a `500` with nothing written. Split the
export into smaller files; that is safe precisely because nothing is deleted and
re-importing unchanged rows does nothing.

---

## 7. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Cannot connect / times out, but the same command works from home | The request is going to `servicedeskapp.vercel.app`, which the government network blocks | Send to `https://www.dcsim.us/api/items/import` — pass `-Uri` if your script still defaults to the old address (§0, §2) |
| `401` every time | Secret mismatch, or a trailing newline on the value in Vercel | Re-copy the value; confirm the header is `Bearer <secret>` |
| `200` but the body is **HTML**, not JSON | The request was redirected to the login page | Tell the app owner — the endpoint's exemption from the login gate has been lost. **This one is dangerous: the job looks successful while importing nothing.** |
| `500` on every request | The service account is missing from the database | Apply the migration named in section 6 |
| `404` | Not deployed yet | Wait for the release |
| "Method invocation is supported only on core types in this language mode" | The machine enforces Constrained Language Mode, and something is calling a .NET method | The current script and the commands in this document avoid those calls — take a fresh copy of `Send-MdmImport.ps1`. If it is your own wrapper, replace `[Environment]::…`, `[Math]::…` and `[System.IO.…]::…` with cmdlets |
| Counts are all `unchanged` | Nothing in the export differs from what's on file | Working as intended |
| A device's hand-corrected details keep reverting | The export is the source of truth for those fields (section 5) | Correct it in the MDM export, not in the app |

---

## 8. Where changes are recorded

Every field this import changes is written to that device's edit history, attributed
to **MDM Import (automated)**. You can see exactly what any run touched from the
device's own page in the app. Combined with the fact that nothing is ever deleted,
a bad import is always a correction — never a loss.
