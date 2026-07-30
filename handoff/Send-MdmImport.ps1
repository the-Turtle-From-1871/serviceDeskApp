<#
.SYNOPSIS
    Sends an MDM/Intune CSV export to the Hand Receipt app.

.DESCRIPTION
    Checks everything it can before sending, posts the file, prints a plain-English
    summary, and exits non-zero on any failure so Task Scheduler shows a red result
    instead of a silent success.

    Works on Windows PowerShell 5.1 and PowerShell 7+.

.EXAMPLE
    # One-off, by hand:
    $env:MDM_IMPORT_SECRET = "paste-the-secret-here"
    .\Send-MdmImport.ps1 -CsvPath .\fleet.csv

.EXAMPLE
    # Scheduled: keep the secret out of the command line entirely.
    # Set MDM_IMPORT_SECRET once as a MACHINE environment variable, then:
    .\Send-MdmImport.ps1 -CsvPath C:\exports\fleet.csv -LogPath C:\exports\import.log
#>

[CmdletBinding()]
param(
    # The CSV to send.
    [Parameter(Mandatory = $true)]
    [string] $CsvPath,

    # The app. You should not need to change this.
    [string] $Uri = "https://servicedeskapp.vercel.app/api/items/import",

    # Defaults to the MDM_IMPORT_SECRET environment variable. Prefer that over
    # passing it here -- an argument shows up in process lists and shell history.
    [string] $Secret = $env:MDM_IMPORT_SECRET,

    # Optional: append a timestamped record of each run here.
    [string] $LogPath
)

$ErrorActionPreference = "Stop"

function Write-Log {
    param([string] $Message, [string] $Colour = "Gray")
    Write-Host $Message -ForegroundColor $Colour
    if ($LogPath) {
        $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        Add-Content -Path $LogPath -Value "$stamp  $Message" -Encoding utf8
    }
}

function Fail {
    param([string] $Message)
    Write-Log "FAILED: $Message" "Red"
    Write-Log "Nothing was imported. Fix the above and run it again." "Red"
    exit 1
}

Write-Log "=== MDM import starting ===" "Cyan"

# --- Preflight: catch the predictable mistakes before touching the network ----

if ([string]::IsNullOrWhiteSpace($Secret)) {
    Fail @"
No secret. Set it first:

    `$env:MDM_IMPORT_SECRET = "the-value-you-were-given"

For a scheduled task, set it as a MACHINE environment variable instead so it
survives reboots and is not visible in the task definition.
"@
}

if ($Secret -ne $Secret.Trim()) {
    Fail "The secret has leading or trailing whitespace. It is compared exactly, so a stray space or newline from copy-paste will be rejected as a wrong secret. Re-copy it."
}

if (-not (Test-Path -LiteralPath $CsvPath)) {
    Fail "File not found: $CsvPath"
}

$file = Get-Item -LiteralPath $CsvPath

if ($file.Extension -ne ".csv") {
    Fail "The file must end in .csv (this one is '$($file.Extension)'). The app rejects anything else."
}

if ($file.Length -eq 0) {
    Fail "That file is empty: $CsvPath"
}

# Row count: the app caps an import at 2000 data rows and rejects more.
$lineCount = 0
$reader = [System.IO.File]::OpenText($file.FullName)
try { while ($null -ne $reader.ReadLine()) { $lineCount++ } } finally { $reader.Close() }
$dataRows = [Math]::Max(0, $lineCount - 1)   # minus the header

Write-Log "File:  $($file.FullName)"
Write-Log "Size:  $([Math]::Round($file.Length / 1KB, 1)) KB"
Write-Log "Rows:  $dataRows (excluding the header)"

if ($dataRows -gt 2000) {
    Fail "That is $dataRows rows; the limit is 2000 per import. Split the export into files of 2000 rows or fewer and send each one."
}

if ($dataRows -eq 0) {
    Fail "That file has a header but no data rows."
}

# --- Send ---------------------------------------------------------------------

Write-Log "Sending to $Uri ..." "Cyan"

$headers = @{ Authorization = "Bearer $Secret" }
$response = $null
$statusCode = $null
$rawBody = $null

try {
    if ($PSVersionTable.PSVersion.Major -ge 6) {
        # PowerShell 7+: -Form does multipart properly.
        $response = Invoke-RestMethod -Uri $Uri -Method Post -Headers $headers `
            -Form @{ file = $file } -TimeoutSec 300
    }
    else {
        # Windows PowerShell 5.1 has NO -Form. Use curl.exe, which ships with
        # Windows 10 1803+ and handles multipart correctly. Do NOT try to hand-roll
        # the multipart body here -- getting the boundaries wrong produces a
        # confusing 400 that looks like a bad CSV.
        $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
        if (-not $curl) {
            Fail "This is Windows PowerShell $($PSVersionTable.PSVersion) and curl.exe was not found. Either install PowerShell 7 (https://aka.ms/powershell) or use a machine with curl.exe (Windows 10 1803 and later include it)."
        }

        $tmp = [System.IO.Path]::GetTempFileName()
        try {
            # -sS: quiet but still show errors. -w: append the status code so we can read it.
            $rawBody = & $curl.Source -sS -X POST $Uri `
                -H "Authorization: Bearer $Secret" `
                -F "file=@$($file.FullName)" `
                -w "`n%{http_code}" 2>$tmp

            $curlErr = Get-Content $tmp -Raw
            if ($LASTEXITCODE -ne 0) { Fail "curl failed: $curlErr" }
        }
        finally { Remove-Item $tmp -ErrorAction SilentlyContinue }

        $lines = $rawBody -split "`n"
        $statusCode = [int]$lines[-1]
        $bodyText = ($lines[0..($lines.Length - 2)] -join "`n").Trim()

        if ($statusCode -ne 200) {
            if ($bodyText -match '<html|<!DOCTYPE') {
                Fail @"
The server returned HTTP $statusCode with an HTML page instead of JSON.

If the status is 200, this means the request was redirected to the login page --
the import endpoint has lost its exemption from the login gate. THE JOB WOULD
LOOK SUCCESSFUL WHILE IMPORTING NOTHING. Report this to the app owner.
"@
            }
            Fail "HTTP $statusCode - $bodyText"
        }

        $response = $bodyText | ConvertFrom-Json
    }
}
catch {
    $resp = $_.Exception.Response
    if ($resp -and $resp.StatusCode) {
        $code = [int]$resp.StatusCode
        switch ($code) {
            401 { Fail "401 Unauthorized - the secret is wrong, missing, or has stray whitespace." }
            400 { Fail "400 Bad Request - the file could not be parsed, is not a .csv, or has more than 2000 rows." }
            413 { Fail "413 Too Large - split the export into smaller files." }
            500 { Fail "500 Server Error - the app failed. Send this whole output to the app owner." }
            default { Fail "HTTP $code - $($_.Exception.Message)" }
        }
    }
    Fail $_.Exception.Message
}

# --- Report -------------------------------------------------------------------

Write-Log ""
Write-Log "=== Import succeeded ===" "Green"
Write-Log "  Added:      $($response.added)      (devices new to the system)"
Write-Log "  Updated:    $($response.updated)    (existing devices whose details changed)"
Write-Log "  Unchanged:  $($response.unchanged)  (already matched the export)"
Write-Log "  Detected:   $($response.detected)   (home unit filled in or corrected)"

$skipped    = @($response.skipped)
$unresolved = @($response.unresolved)
$mismatches = @($response.mismatches)

if ($skipped.Count -gt 0) {
    Write-Log ""
    Write-Log "  $($skipped.Count) row(s) were SKIPPED and did not import:" "Yellow"
    $skipped | Select-Object -First 10 | ForEach-Object {
        Write-Log "    row $($_.row)  $($_.serialNumber)  -  $($_.reason)" "Yellow"
    }
    if ($skipped.Count -gt 10) { Write-Log "    ... and $($skipped.Count - 10) more" "Yellow" }
}

if ($unresolved.Count -gt 0) {
    Write-Log ""
    Write-Log "  $($unresolved.Count) device(s) imported WITHOUT a home unit." "Yellow"
    Write-Log "  These are not failures - the devices are in the system. Someone can" "Yellow"
    Write-Log "  teach the abbreviation at Admin -> Units and a later import fills it in." "Yellow"
}

if ($mismatches.Count -gt 0) {
    Write-Log ""
    Write-Log "  $($mismatches.Count) device(s) have a make/model differing from the export." "Yellow"
    Write-Log "  Those fields are never overwritten - a person should look at them." "Yellow"
}

Write-Log ""
Write-Log "Done." "Green"
exit 0
