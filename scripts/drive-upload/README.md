# Drive upload (government workstation side)

Publishes the MDM fleet export to **one fixed Google Drive file**, which the app
then collects on a schedule (`/api/cron/import-drive`, see `DEPLOY.md` section 8).

This exists because the workstation that produces the export **cannot reach the
app at all** — the network's web filter refuses the domain, so the direct push in
`DEPLOY.md` section 7 (`POST /api/items/import`) fails with WinSock 10061 and the
browser upload at `/admin/items/import` is blocked too. Drive is reachable from
that workstation, so it is used as the relay.

> **Prefer section 7 if it ever becomes possible.** Getting `www.dcsim.us`
> allowlisted removes the need for this entirely, and with it the accepted risk
> that the export sits on a publicly-readable URL (`docs/SECURITY.md`, Known gaps
> **0g**).

## What it does, and the one rule that matters

`Upload-FleetCsv.ps1` calls `files.update` with `uploadType=media`, which
**replaces the contents of an existing file, keeping the same file ID, the same
sharing settings and the same link**, and records a new Drive revision.

**It never creates a file, deliberately.** The app reads one fixed URL
(`DRIVE_CSV_URL`). A script that created a new file each run would mint a new ID
every time, leave the app pointed at a file that never changes again, and the
import would report `"unchanged"` every morning forever while this script
reported success. `-FileId` is required and there is no create path.

## Why a service account rather than an OAuth user credential

A service account has its **own empty Drive**. Even the broad
`https://www.googleapis.com/auth/drive` scope therefore reaches only what has
been explicitly shared with that account — the one CSV — whereas a *user* OAuth
credential with the same scope would expose the whole of that person's Drive.
That distinction matters when the credential lives on a managed workstation.

It also has **no refresh token**, so there is nothing to expire or re-mint. (The
narrower `drive.file` scope is not usable here: it covers only files the
credential itself created, and this file is created by hand in the browser.)

## One-time setup

1. **Create the service account.** Google Cloud console -> IAM & Admin ->
   Service Accounts -> Create. No project roles are needed; its access comes
   from Drive sharing, not IAM. Note its address, e.g.
   `fleet-upload@<project>.iam.gserviceaccount.com`.

2. **Create a key.**
   - **PowerShell 5.1 (verified working):** Keys -> Add key -> Create new key ->
     **P12**. Google marks P12 "not recommended unless necessary for backwards
     compatibility" — Windows PowerShell 5.1 is exactly that case, because a JSON
     key's PKCS#8 private key needs `ImportPkcs8PrivateKey`, which is .NET Core
     3.0+ and does not exist on 5.1. The generated P12's password is
     conventionally `notasecret`.
   - **PowerShell 7+:** either format; **JSON** is Google's recommendation.

   Treat the key file as a credential: restrict it with NTFS permissions to the
   account the scheduled task runs as.

3. **Create the CSV in Drive and share it twice.** Upload any starter CSV, then:
   - **Share -> add the service account's address as `Editor`.** Without this,
     step 5 fails with a `404` (Drive reports an unreachable file as missing).
   - **Share -> General access -> Anyone with the link -> Viewer**, which is what
     lets the app fetch it with no credential. This is the accepted risk 0g
     above.

4. **Grab the file ID** from the share link — the long middle segment of
   `https://drive.google.com/file/d/<FILE_ID>/view`. The app's `DRIVE_CSV_URL`
   is `https://drive.google.com/uc?export=download&id=<FILE_ID>`.

5. **Dry run** (validates the key, the token and file access; writes nothing):

   ```powershell
   .\Upload-FleetCsv.ps1 -CsvPath .\fleet.csv -FileId <FILE_ID> `
     -KeyPath .\fleet-upload.p12 -KeyPassword notasecret `
     -ClientEmail fleet-upload@<project>.iam.gserviceaccount.com -WhatIf
   ```

   Drop `-WhatIf` to publish for real.

## Running it unattended

Every parameter falls back to an environment variable, so a Scheduled Task action
can be just the script path:

| Variable | Meaning |
|---|---|
| `DRIVE_FILE_ID` | The Drive file to overwrite |
| `DRIVE_SA_KEY_PATH` | Path to the `.p12` / `.json` key |
| `DRIVE_SA_KEY_PASSWORD` | P12 password (`notasecret` for a Google-generated P12) |
| `DRIVE_SA_CLIENT_EMAIL` | Service account address — **required for P12**, which does not carry it (a JSON key does, in `client_email`) |

```
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\ops\Upload-FleetCsv.ps1 -CsvPath C:\ops\fleet.csv
```

Schedule it to finish **before** the app's collection at 09:17 UTC
(`.github/workflows/drive-import-cron.yml`). Running it more often is harmless:
the app fingerprints the contents and skips an unchanged export without opening
a transaction.

## Checks the script makes before publishing

Each of these fails on the workstation, where somebody is watching, rather than
in a cron log the next morning:

- The CSV is **non-empty** and **within 5,000,000 bytes** (the importer's own
  ceiling, `src/modules/items/drive-csv.ts`).
- The first line **mentions a serial column** — a warning, not a refusal, since
  header naming is flexible; but an export with no `serialNumber` imports zero
  rows.
- The target file **exists and is reachable** by the service account, read via a
  metadata call before any upload.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `404` on the metadata read | The file is not shared with the service account (step 3), or the file ID is wrong. Drive reports unreachable as missing. |
| Token refused, `invalid_grant` | Workstation clock skew (the JWT's `iat`/`exp` are absolute), or `-ClientEmail` does not match the key's account. |
| Token refused, `unauthorized_client` | The scope was rejected for that account. |
| `A .json service account key needs PowerShell 7+` | You are on 5.1. Create a P12 key instead — see step 2. |
| App reports `"unchanged"` forever | Someone uploaded a *new* file instead of running this script, so the app is reading the old, now-static file ID. |
| App reports `502 ... returned a web page, not a CSV` | Public link sharing was turned off in step 3. |
