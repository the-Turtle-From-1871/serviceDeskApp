<#
.SYNOPSIS
  Import the newest `items*.csv` from the Downloads folder into the hand-receipt
  app via POST /api/items/import, then delete it.

.DESCRIPTION
  This is the direct-push import for a workstation that CAN reach the app. It is
  the path DEPLOY.md section 7 describes, and the one scripts/drive-upload/README.md
  says to prefer wherever it is possible -- the Drive relay exists only for the
  government workstation whose web filter refuses the domain.

  The same script serves both uses. Running it by hand is a manual import;
  Setup-ImportTask.ps1 registers a Scheduled Task that runs it with -Quiet every
  few minutes.

  WHY IT POLLS RATHER THAN WATCHES. A successful import DELETES the file, so the
  presence of any `items*.csv` in Downloads is itself the "something new arrived"
  signal. That removes the need for hash tracking, a state file, or a resident
  FileSystemWatcher that can die silently and stop importing with no symptom. A
  poll that finds nothing makes no network request at all.

  THE ONE INVARIANT: the file is deleted on EXACTLY ONE path -- an HTTP 200 whose
  body parsed as JSON with integer `added`/`updated`/`unchanged`. Every other
  outcome leaves it in place, so the next poll retries it. Two things make that
  validation load-bearing rather than paranoid:

    * /api/items/import is excluded from the proxy matcher (src/proxy.ts) ON
      PURPOSE. If that exclusion ever lapses, the coarse login gate 302s this
      POST to /login, and Invoke-RestMethod follows redirects by default -- so
      the redirect comes back as a 200 carrying login-page HTML. The comment in
      src/proxy.ts calls this "a scheduled job that logs success while importing
      nothing"; here it would also destroy the CSV. Hence -MaximumRedirection 0
      AND the response-shape check.
    * A non-200 means NOTHING was written (the whole import is one transaction),
      so keeping the file and retrying is always the correct response.

  WINDOWS POWERSHELL 5.1 COMPATIBLE THROUGHOUT: no ternary, no ??, no && / ||.
  In particular the multipart body is built BY HAND, because
  `Invoke-RestMethod -Form` does not exist before PowerShell 6.1 -- the example
  in DEPLOY.md section 7 is PowerShell 7 only and cannot run on 5.1 as written.

.PARAMETER CsvPath
  Import this specific file instead of searching Downloads.

.PARAMETER DownloadsPath
  Folder to search. Defaults to the shell's Downloads known folder, falling back
  to $env:USERPROFILE\Downloads -- so a OneDrive-redirected Downloads still works.

.PARAMETER BaseUrl
  App origin. Defaults to $env:INVENTORY_APP_URL, then https://www.dcsim.us.

.PARAMETER Secret
  MDM_IMPORT_SECRET. Defaults to the environment variable, then to the
  DPAPI-encrypted file written by Setup-ImportTask.ps1.

.PARAMETER KeepFile
  Import but do NOT delete. For manual runs when you want to keep the export.

.PARAMETER Quiet
  Log to file only; no console output. What the Scheduled Task uses.

.PARAMETER WhatIf
  Do everything except the POST -- discovery, the settled-file guards and the
  local pre-checks all run. Nothing is sent and nothing is deleted.

.EXAMPLE
  .\Import-ItemsCsv.ps1 -WhatIf

.EXAMPLE
  # Manual import of the newest items*.csv, keeping the file:
  .\Import-ItemsCsv.ps1 -KeepFile

.EXAMPLE
  # One specific file:
  .\Import-ItemsCsv.ps1 -CsvPath 'C:\Users\xAdmin\Downloads\items (3).csv'
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string] $CsvPath,

    [string] $DownloadsPath,

    [string] $BaseUrl = $env:INVENTORY_APP_URL,

    [string] $Secret = $env:MDM_IMPORT_SECRET,

    [string] $StateDir = 'C:\ops\items-import',

    [string] $Pattern = 'items*.csv',

    [switch] $KeepFile,

    [switch] $Quiet
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# MAX_CSV_BYTES in src/app/api/items/import/route.ts. Checked here so an
# oversized export fails on this machine, where somebody is looking, rather than
# as a 413 in a log nobody reads.
$script:MaxCsvBytes = 5000000
$script:LogPath = Join-Path $StateDir 'import.log'
$script:SecretPath = Join-Path $StateDir 'secret.txt'
# Trim only once the log exceeds the high-water mark, so the common path never
# rewrites the file.
$script:LogKeepLines = 500
$script:LogTrimAtLines = 600

if ([string]::IsNullOrWhiteSpace($BaseUrl)) { $BaseUrl = 'https://www.dcsim.us' }
$BaseUrl = $BaseUrl.TrimEnd('/')

# ---------------------------------------------------------------------------
# Output and logging
# ---------------------------------------------------------------------------

function Write-Step {
    param([string] $Message)
    if (-not $Quiet) { Write-Host "[items-import] $Message" }
}

function Write-Log {
    param(
        [string] $Message,
        # Detail lines nested under a run (skipped rows, mismatches) omit the
        # timestamp: repeating it on every child line buries the indentation that
        # shows they belong to the run above, and makes the summary lines harder
        # to pick out.
        [switch] $NoStamp
    )
    try {
        if (-not (Test-Path -LiteralPath $StateDir)) {
            New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
        }
        $line = $Message
        if (-not $NoStamp) {
            $line = "$((Get-Date).ToString('yyyy-MM-ddTHH:mm:ssK'))  $Message"
        }
        Add-Content -LiteralPath $script:LogPath -Value $line -Encoding UTF8

        # Cheap bound on the log. It is the ONLY local record of what was sent
        # once the CSV is deleted, so it is trimmed rather than rotated away.
        $lines = @(Get-Content -LiteralPath $script:LogPath -ErrorAction SilentlyContinue)
        if ($lines.Count -gt $script:LogTrimAtLines) {
            $keep = $lines[($lines.Count - $script:LogKeepLines)..($lines.Count - 1)]
            Set-Content -LiteralPath $script:LogPath -Value $keep -Encoding UTF8
        }
    } catch {
        # A log failure must never be the reason an import fails.
        if (-not $Quiet) { Write-Warning "Could not write $($script:LogPath): $($_.Exception.Message)" }
    }
}

# A genuine failure: log it, say so, and exit non-zero so Task Scheduler's
# Last Run Result actually means something. The CSV is left in place.
function Stop-WithFailure {
    param([string] $Message)
    Write-Log "FAILED  $Message"
    if ($Quiet) { Write-Error $Message -ErrorAction Continue }
    else { Write-Host "[items-import] FAILED: $Message" -ForegroundColor Red }
    exit 1
}

# Nothing to do, or something that will resolve itself on the next poll. Exit 0
# and stay quiet: on a 5-minute cadence this is the overwhelmingly common case,
# and painting Last Run Result red for it trains the user to ignore it.
function Stop-Quietly {
    param([string] $Message)
    Write-Step $Message
    exit 0
}

# ---------------------------------------------------------------------------
# Secret
# ---------------------------------------------------------------------------

<#
  Resolve MDM_IMPORT_SECRET: parameter, then environment, then the
  DPAPI-encrypted file written by Setup-ImportTask.ps1.

  DPAPI ties the stored value to this Windows account, so copying secret.txt to
  another machine or reading it as another user yields nothing.

  This decrypt works under BOTH scheduled-task logon types -- Interactive and S4U
  (S4U verified 2026-08-11). An earlier comment here claimed S4U could not reach
  the user's DPAPI master key; that was wrong, and it mattered, because S4U is the
  only logon type that runs at all on a machine that refuses Interactive tasks.
#>
function Resolve-ImportSecret {
    param([string] $Provided)

    if (-not [string]::IsNullOrWhiteSpace($Provided)) { return $Provided }

    if (-not (Test-Path -LiteralPath $script:SecretPath)) {
        Stop-WithFailure ("No import secret. Pass -Secret, set MDM_IMPORT_SECRET, or run " +
                          "Setup-ImportTask.ps1 to store it in $($script:SecretPath).")
    }

    try {
        $encrypted = Get-Content -LiteralPath $script:SecretPath -Raw
        $secure = ConvertTo-SecureString -String $encrypted.Trim()
        $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try {
            return [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
        } finally {
            [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        }
    } catch {
        Stop-WithFailure ("Could not decrypt $($script:SecretPath). It is encrypted to a single " +
                          "Windows account -- re-run Setup-ImportTask.ps1 as the account that " +
                          "runs the task. ($($_.Exception.Message))")
    }
}

# ---------------------------------------------------------------------------
# Finding the file
# ---------------------------------------------------------------------------

<#
  The shell's Downloads known folder, so a redirected (OneDrive) Downloads is
  still found. Falls back to the conventional location.
#>
function Get-DownloadsFolder {
    $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders'
    $guid = '{374DE290-123F-4565-9164-39C4925E467B}'
    try {
        $item = Get-ItemProperty -Path $key -Name $guid -ErrorAction Stop
        $raw = $item.$guid
        if (-not [string]::IsNullOrWhiteSpace($raw)) {
            # The value is usually a REG_EXPAND_SZ holding %USERPROFILE%\Downloads.
            $expanded = [Environment]::ExpandEnvironmentVariables($raw)
            if (Test-Path -LiteralPath $expanded) { return $expanded }
        }
    } catch {
        # Fall through to the default below.
    }
    return (Join-Path $env:USERPROFILE 'Downloads')
}

<#
  Is this file finished downloading?

  Three independent signals, because sending a truncated CSV would import partial
  rows and then delete the evidence:
    1. no in-flight download marker beside it (Chrome/Edge write `.crdownload`,
       Firefox `.part`);
    2. the file opens with FileShare::None -- a browser still writing it holds a
       lock, so this fails;
    3. it is not empty.
#>
function Test-FileIsSettled {
    param(
        [Parameter(Mandatory = $true)] $File,
        [Parameter(Mandatory = $true)][string] $Folder
    )

    $inFlight = @(Get-ChildItem -LiteralPath $Folder -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like 'items*.crdownload' -or $_.Name -like 'items*.part' -or $_.Name -like 'items*.csv.tmp' })
    if ($inFlight.Count -gt 0) {
        return @{ Settled = $false; Reason = "a download is still in flight ($($inFlight[0].Name))" }
    }

    if ($File.Length -eq 0) {
        return @{ Settled = $false; Reason = "$($File.Name) is 0 bytes" }
    }

    try {
        $stream = [System.IO.File]::Open(
            $File.FullName,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            [System.IO.FileShare]::None)
        $stream.Close()
        $stream.Dispose()
    } catch {
        return @{ Settled = $false; Reason = "$($File.Name) is locked by another process" }
    }

    return @{ Settled = $true; Reason = '' }
}

# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

<#
  Build a multipart/form-data body by hand and POST it.

  `Invoke-RestMethod -Form` would do this in one line -- and does NOT exist on
  Windows PowerShell 5.1 (added in 6.1). The body is assembled as BYTES through a
  MemoryStream rather than by string concatenation, so the CSV's own encoding is
  passed through untouched rather than being round-tripped through a string.
#>
function Invoke-ImportPost {
    param(
        [Parameter(Mandatory = $true)][string] $Uri,
        [Parameter(Mandatory = $true)][string] $Token,
        [Parameter(Mandatory = $true)] $File
    )

    $boundary = [Guid]::NewGuid().ToString()
    $LF = "`r`n"

    # The server reads the `file` field and requires a .csv filename
    # (route.ts). Quotes are stripped from the filename rather than escaped:
    # a header value cannot carry a raw quote, and no legitimate export has one.
    $safeName = $File.Name -replace '"', ''

    $head = "--$boundary$LF" +
            "Content-Disposition: form-data; name=`"file`"; filename=`"$safeName`"$LF" +
            "Content-Type: text/csv$LF$LF"
    $tail = "$LF--$boundary--$LF"

    $stream = New-Object System.IO.MemoryStream
    try {
        $headBytes = [System.Text.Encoding]::UTF8.GetBytes($head)
        $stream.Write($headBytes, 0, $headBytes.Length)

        $fileBytes = [System.IO.File]::ReadAllBytes($File.FullName)
        $stream.Write($fileBytes, 0, $fileBytes.Length)

        $tailBytes = [System.Text.Encoding]::UTF8.GetBytes($tail)
        $stream.Write($tailBytes, 0, $tailBytes.Length)

        $body = $stream.ToArray()
    } finally {
        $stream.Dispose()
    }

    # -MaximumRedirection 0: never chase a 302. See the note at the top -- a
    # followed redirect to /login returns 200 with HTML, and this script deletes
    # files on 200.
    return Invoke-RestMethod -Uri $Uri -Method Post `
        -Headers @{ Authorization = "Bearer $Token" } `
        -ContentType "multipart/form-data; boundary=$boundary" `
        -Body $body `
        -MaximumRedirection 0 `
        -TimeoutSec 120
}

# Pull the server's own message out of a 4xx/5xx. Its wording is written for the
# operator ("more than 2000 rows", "must be a .csv file") and is far more useful
# than the status code alone.
function Get-ErrorDetail {
    param($ErrorRecord)

    $status = 0
    $body = ''
    try { $status = [int] $ErrorRecord.Exception.Response.StatusCode } catch { $status = 0 }
    try {
        $stream = $ErrorRecord.Exception.Response.GetResponseStream()
        $reader = New-Object System.IO.StreamReader($stream)
        $body = $reader.ReadToEnd()
        $reader.Dispose()
    } catch { $body = '' }

    $message = $ErrorRecord.Exception.Message
    if (-not [string]::IsNullOrWhiteSpace($body)) {
        try {
            $parsed = $body | ConvertFrom-Json
            if ($null -ne $parsed.PSObject.Properties['error']) { $message = $parsed.error }
            else { $message = $body }
        } catch {
            # Not JSON. Truncate -- an HTML error page is not worth a log entry.
            if ($body.Length -gt 200) { $message = $body.Substring(0, 200) + '...' }
            else { $message = $body }
        }
    }

    return @{ Status = $status; Message = $message }
}

<#
  Read an integer field off the parsed response.

  Returns $null when the field is absent or non-numeric -- which is how
  login-page HTML is detected: Invoke-RestMethod hands back a plain string for a
  non-JSON body, and a string has no `added` property. StrictMode makes a bare
  $response.added throw in that case, so the property is probed rather than read.
#>
function Get-ResponseInt {
    param($Response, [string] $Name)

    if ($null -eq $Response) { return $null }
    if ($Response -is [string]) { return $null }

    $prop = $null
    try { $prop = $Response.PSObject.Properties[$Name] } catch { return $null }
    if ($null -eq $prop) { return $null }

    $parsed = 0
    if ([int]::TryParse([string] $prop.Value, [ref] $parsed)) { return $parsed }
    return $null
}

# Count an array-valued field (`skipped`, `mismatches`) defensively -- DEPLOY.md
# section 7 warns these are arrays while the first three fields are counts.
function Get-ResponseArray {
    param($Response, [string] $Name)

    if ($null -eq $Response) { return @() }
    if ($Response -is [string]) { return @() }

    $prop = $null
    try { $prop = $Response.PSObject.Properties[$Name] } catch { return @() }
    if ($null -eq $prop) { return @() }
    if ($null -eq $prop.Value) { return @() }
    return @($prop.Value)
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

# --- Choose the file --------------------------------------------------------

$folder = $DownloadsPath
if ([string]::IsNullOrWhiteSpace($folder)) { $folder = Get-DownloadsFolder }

if (-not [string]::IsNullOrWhiteSpace($CsvPath)) {
    if (-not (Test-Path -LiteralPath $CsvPath)) {
        Stop-WithFailure "CSV not found: $CsvPath"
    }
    $csv = Get-Item -LiteralPath $CsvPath
    $folder = $csv.DirectoryName
} else {
    if (-not (Test-Path -LiteralPath $folder)) {
        Stop-WithFailure "Downloads folder not found: $folder"
    }

    # -Filter is the fast path, but Windows' legacy wildcard matching can also
    # match a file's 8.3 short name, so the result is re-checked with -like.
    $candidates = @(Get-ChildItem -LiteralPath $folder -Filter $Pattern -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like $Pattern } |
        Sort-Object LastWriteTime -Descending)

    if ($candidates.Count -eq 0) {
        # THE normal outcome on a 5-minute poll. No request, no log line.
        Stop-Quietly "No $Pattern in $folder. Nothing to do."
    }

    $csv = $candidates[0]
    if ($candidates.Count -gt 1) {
        Write-Step "$($candidates.Count) candidates; taking the newest: $($csv.Name)"
    }
}

# --- Guards -----------------------------------------------------------------

$settled = Test-FileIsSettled -File $csv -Folder $folder
if (-not $settled.Settled) {
    # Deliberately exit 0: this resolves itself, and the next poll picks it up.
    Stop-Quietly "Waiting -- $($settled.Reason)."
}

if ($csv.Length -gt $script:MaxCsvBytes) {
    Stop-WithFailure ("$($csv.Name) is $($csv.Length) bytes; the endpoint's limit is " +
                      "$($script:MaxCsvBytes). Split the export. The file has been left in place.")
}

# Shape warning, not a refusal -- header naming is flexible and the server's 400
# is authoritative. A file the server refuses is never deleted, so warning and
# sending is safe.
$firstLine = Get-Content -LiteralPath $csv.FullName -TotalCount 1
if ($firstLine -notmatch '(?i)serial') {
    Write-Step "WARNING: the header of $($csv.Name) does not mention a serial column; this may import zero rows."
}

$uri = "$BaseUrl/api/items/import"
Write-Step "Importing $($csv.Name) ($($csv.Length) bytes) to $uri"

if (-not $PSCmdlet.ShouldProcess($uri, "Import $($csv.Name)")) {
    Write-Step "-WhatIf: found the file and passed every local check. Nothing was sent, nothing was deleted."
    exit 0
}

# --- Send -------------------------------------------------------------------

$token = Resolve-ImportSecret -Provided $Secret

$response = $null
try {
    $response = Invoke-ImportPost -Uri $uri -Token $token -File $csv
} catch {
    $detail = Get-ErrorDetail -ErrorRecord $_

    if ($detail.Status -eq 401) {
        Stop-WithFailure ("401 Unauthorized -- the import secret is wrong or unset in Vercel. " +
                          "Nothing was imported and $($csv.Name) was kept.")
    }
    if ($detail.Status -ge 300 -and $detail.Status -lt 400) {
        Stop-WithFailure ("The server redirected ($($detail.Status)). /api/items/import must stay " +
                          "excluded from the proxy matcher in src/proxy.ts. $($csv.Name) was kept.")
    }
    Stop-WithFailure "HTTP $($detail.Status): $($detail.Message). $($csv.Name) was kept."
}

# --- Validate before touching the file --------------------------------------

$added = Get-ResponseInt -Response $response -Name 'added'
$updated = Get-ResponseInt -Response $response -Name 'updated'
$unchanged = Get-ResponseInt -Response $response -Name 'unchanged'

if ($null -eq $added -or $null -eq $updated -or $null -eq $unchanged) {
    # A 200 that is not an import summary. The likeliest cause is login-page HTML
    # from a followed redirect (see the note at the top). Refusing to delete here
    # is the entire reason this check exists.
    Stop-WithFailure ("The server returned 200 but not an import summary -- so the import did NOT " +
                      "happen. $($csv.Name) was kept. Check that /api/items/import is still excluded " +
                      "from the proxy matcher in src/proxy.ts.")
}

# The @() around each call is load-bearing, NOT decoration. PowerShell unwraps a
# single-element array on return, so a response carrying exactly ONE skipped row
# hands back a bare PSCustomObject, and an empty list collapses to $null. Under
# Set-StrictMode -Version Latest, `.Count` on either throws
# PropertyNotFoundStrict -- after the import has already been committed
# server-side. In a scheduled run that left the CSV undeleted and re-imported on
# every poll thereafter.
$skipped = @(Get-ResponseArray -Response $response -Name 'skipped')
$mismatches = @(Get-ResponseArray -Response $response -Name 'mismatches')

$summary = "added=$added updated=$updated unchanged=$unchanged skipped=$($skipped.Count) mismatches=$($mismatches.Count)"
Write-Step "Imported. $summary"

# --- Delete -----------------------------------------------------------------

$disposition = 'kept (-KeepFile)'
if (-not $KeepFile) {
    try {
        Remove-Item -LiteralPath $csv.FullName -Force
        $disposition = 'deleted'
        Write-Step "Deleted $($csv.Name)."
    } catch {
        # The import DID succeed, so this is not a failure of the import -- but it
        # must be loud, because a file left behind will be imported again on the
        # next poll.
        $disposition = "DELETE FAILED ($($_.Exception.Message))"
        Write-Log "$($csv.Name)  $($csv.Length) bytes  $summary  $disposition"
        Stop-WithFailure ("Imported successfully, but $($csv.Name) could not be deleted and will be " +
                          "re-imported on the next run: $($_.Exception.Message)")
    }
}

Write-Log "$($csv.Name)  $($csv.Length) bytes  $summary  $disposition"

# Per-row detail, only when there is any. Once the CSV is gone this log and the
# app's ImportBatch row are the only record of what was sent.
foreach ($row in $skipped) {
    $rowNum = ''
    $serial = ''
    $reason = ''
    try { $rowNum = $row.row } catch { $rowNum = '?' }
    try { $serial = $row.serialNumber } catch { $serial = '?' }
    try { $reason = $row.reason } catch { $reason = '?' }
    Write-Log "    skipped row $rowNum ($serial): $reason" -NoStamp
}
foreach ($m in $mismatches) {
    $serial = ''
    try { $serial = $m.serialNumber } catch { $serial = '?' }
    Write-Log "    make/model mismatch: $serial" -NoStamp
}

if ($skipped.Count -gt 0) {
    Write-Step "$($skipped.Count) row(s) were skipped -- see $($script:LogPath)."
}

exit 0
