[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $CsvPath,

    [string] $Uri = "https://www.dcsim.us/api/items/import",

    [string] $Secret = $env:MDM_IMPORT_SECRET,

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
Write-Log "PowerShell $($PSVersionTable.PSVersion) ($($ExecutionContext.SessionState.LanguageMode))"

if ($Secret -notmatch '\S') {
    Fail @"
No secret. Set it first:

    `$env:MDM_IMPORT_SECRET = "the-value-you-were-given"

For a scheduled task, set it as a MACHINE environment variable instead so it
survives reboots and is not visible in the task definition.
"@
}

if ($Secret -match '^\s|\s$') {
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

$lineCount = @(Get-Content -LiteralPath $file.FullName).Count
$dataRows = if ($lineCount -gt 1) { $lineCount - 1 } else { 0 }   # minus the header

Write-Log "File:  $($file.FullName)"
Write-Log "Size:  $("{0:N1}" -f ($file.Length / 1KB)) KB"
Write-Log "Rows:  $dataRows (excluding the header)"

if ($dataRows -gt 2000) {
    Fail "That is $dataRows rows; the limit is 2000 per import. Split the export into files of 2000 rows or fewer and send each one."
}

if ($dataRows -eq 0) {
    Fail "That file has a header but no data rows."
}

Write-Log "Sending to $Uri ..." "Cyan"

$headers = @{ Authorization = "Bearer $Secret" }
$response = $null
$statusCode = $null
$rawBody = $null

try {
    if ($PSVersionTable.PSVersion.Major -ge 6) {
        $response = Invoke-RestMethod -Uri $Uri -Method Post -Headers $headers `
            -Form @{ file = $file } -TimeoutSec 300
    }
    else {
        $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
        if (-not $curl) {
            Fail "This is Windows PowerShell $($PSVersionTable.PSVersion) and curl.exe was not found. Either install PowerShell 7 (https://aka.ms/powershell) or use a machine with curl.exe (Windows 10 1803 and later include it)."
        }

        $tmp = Join-Path $env:TEMP "mdm-import-$PID.stderr.txt"
        try {
            $rawBody = & $curl.Source -sSL -X POST $Uri `
                -H "Authorization: Bearer $Secret" `
                -F "file=@$($file.FullName)" `
                -w "`n%{http_code}" 2>$tmp

            $curlErr = Get-Content $tmp -Raw
            if ($LASTEXITCODE -ne 0) { Fail "curl failed: $curlErr" }
        }
        finally { Remove-Item $tmp -ErrorAction SilentlyContinue }

        $lines = $rawBody -split "`n"
        $statusCode = [int]$lines[-1]
        $bodyText = ($lines[0..($lines.Length - 2)] -join "`n") -replace '^\s+|\s+$', ''

        if ($bodyText -match '<html|<!DOCTYPE') {
            Fail @"
The server returned HTTP $statusCode with an HTML page instead of JSON.

The request reached a web page rather than the import endpoint -- most likely it
was redirected to the login page, meaning the endpoint has lost its exemption
from the login gate. On a 200 THE JOB WOULD OTHERWISE LOOK SUCCESSFUL WHILE
IMPORTING NOTHING. Report this to the app owner.
"@
        }

        if ($statusCode -ne 200) {
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
    Fail "$($_.Exception.Message)`n$($_.InvocationInfo.PositionMessage)"
}

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
