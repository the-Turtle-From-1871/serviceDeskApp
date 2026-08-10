<#
.SYNOPSIS
  Replace the contents of ONE existing Google Drive file with a local CSV,
  authenticating as a service account. Intended to run unattended on the
  workstation that produces the MDM export.

.DESCRIPTION
  This is the upload half of the scheduled Drive import. The workstation that
  produces the fleet export cannot reach the hand-receipt app at all (its web
  filter refuses the domain), so the export is published to Drive here and
  collected by /api/cron/import-drive from the other side. See DEPLOY.md section 8.

  IT UPDATES; IT NEVER CREATES. `files.update` keeps the same file ID, the same
  sharing settings and the same link, and records a new revision. That is the
  whole point: the app reads ONE fixed URL (`DRIVE_CSV_URL`), so a script that
  created a new file each run would mint a new ID, leave the app pointed at a
  file that never changes again, and the import would report "unchanged" every
  morning forever while this script cheerfully reported success. -FileId is
  therefore REQUIRED and there is deliberately no create path.

  AUTH -- service account, not a user credential. This matters on a managed
  workstation: a service account has its own empty Drive, so even the broad
  `drive` scope reaches only what has been explicitly shared with that account
  (the one CSV). A *user* OAuth credential with the same scope would expose the
  whole of that person's Drive. There is also no refresh token to expire.

  KEY FORMAT -- both are supported, and which one you can use depends on the
  PowerShell version:
    * .p12  works on Windows PowerShell 5.1 AND PowerShell 7 (X509Certificate2).
    * .json works on PowerShell 7 ONLY -- decoding its PKCS#8 private key needs
            ImportPkcs8PrivateKey, which is .NET Core 3.0+ and simply does not
            exist on 5.1. The script says so rather than failing obscurely.
  Google marks P12 "not recommended unless necessary for backwards
  compatibility" -- running on 5.1 is exactly that case.

  Windows PowerShell 5.1 compatible throughout: no ternary, no ??, no && / ||.

.PARAMETER CsvPath
  The freshly exported CSV to publish.

.PARAMETER FileId
  The Drive file ID to overwrite -- the long segment of the share link
  (https://drive.google.com/file/d/<FILE_ID>/view). Must already exist and be
  shared with the service account as Editor.

.PARAMETER KeyPath
  Service account key file (.json or .p12).

.PARAMETER KeyPassword
  Password for a .p12 key. Google's generated P12 keys conventionally use
  "notasecret"; this is not stated in current documentation, so it is a
  parameter rather than a hardcoded default.

.PARAMETER WhatIf
  Validate everything -- key, token, file access, size -- and stop before writing.

.EXAMPLE
  .\Upload-FleetCsv.ps1 -CsvPath .\fleet.csv -FileId 1AbC... -KeyPath .\sa.p12 -KeyPassword notasecret

.EXAMPLE
  # Scheduled Task action, reading config from machine environment variables:
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\ops\Upload-FleetCsv.ps1 -CsvPath C:\ops\fleet.csv
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [string] $CsvPath,

    [string] $FileId = $env:DRIVE_FILE_ID,

    [string] $KeyPath = $env:DRIVE_SA_KEY_PATH,

    [string] $KeyPassword = $env:DRIVE_SA_KEY_PASSWORD,

    # Only needed for a .p12 key, which does not carry the address the way a
    # .json key's `client_email` field does.
    [string] $ClientEmail = $env:DRIVE_SA_CLIENT_EMAIL,

    # Scope note: `drive.file` covers only files the credential itself created,
    # so it cannot touch a file you made by hand in the browser -- which is this
    # exact setup. `drive` is therefore required here, and is safe precisely
    # because this is a service account (see DESCRIPTION).
    [string] $Scope = 'https://www.googleapis.com/auth/drive'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# The importer's own ceiling (src/modules/items/drive-csv.ts). Checked here so an
# oversized export fails on the workstation, where somebody is looking, rather
# than silently 502-ing in a cron log tomorrow morning.
$script:MaxCsvBytes = 5000000
$script:TokenEndpoint = 'https://oauth2.googleapis.com/token'

function Write-Step { param([string] $Message) Write-Host "[drive-upload] $Message" }

function ConvertTo-Base64Url {
    param([Parameter(Mandatory = $true)][byte[]] $Bytes)
    $b64 = [Convert]::ToBase64String($Bytes)
    $b64 = $b64.Replace('+', '-').Replace('/', '_')
    return $b64.TrimEnd('=')
}

function ConvertTo-Base64UrlText {
    param([Parameter(Mandatory = $true)][string] $Text)
    return ConvertTo-Base64Url -Bytes ([System.Text.Encoding]::UTF8.GetBytes($Text))
}

<#
  Load the signing key and the service account's own email address.

  Returns a hashtable @{ Rsa = <RSA>; ClientEmail = <string>; Disposable = <obj> }.
  The caller disposes. The private key is never written to the console, a log,
  or an exception message -- only the client email ever surfaces.
#>
function Get-ServiceAccountKey {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [string] $Password,
        [string] $ClientEmailOverride
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Service account key not found: $Path"
    }

    $extension = [System.IO.Path]::GetExtension($Path).ToLowerInvariant()

    if ($extension -eq '.json') {
        if ($PSVersionTable.PSVersion.Major -lt 6) {
            throw ("A .json service account key needs PowerShell 7+ on this machine " +
                   "(decoding its PKCS#8 key uses ImportPkcs8PrivateKey, which does not " +
                   "exist on Windows PowerShell $($PSVersionTable.PSVersion)). Either install " +
                   "PowerShell 7, or create a P12 key for this service account in the Google " +
                   "Cloud console and pass that instead.")
        }

        $json = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
        $pem = $json.private_key
        $body = $pem -replace '-----BEGIN PRIVATE KEY-----', '' `
                     -replace '-----END PRIVATE KEY-----', ''
        $body = $body -replace '\s', ''
        $der = [Convert]::FromBase64String($body)

        $rsa = [System.Security.Cryptography.RSA]::Create()
        $bytesRead = 0
        $rsa.ImportPkcs8PrivateKey($der, [ref] $bytesRead)

        return @{ Rsa = $rsa; ClientEmail = $json.client_email; Disposable = $rsa }
    }

    if ($extension -eq '.p12' -or $extension -eq '.pfx') {
        # A P12 carries the key but NOT the service account's email address, so
        # it has to be supplied. This is the one ergonomic cost of the 5.1 path.
        if ([string]::IsNullOrWhiteSpace($ClientEmailOverride)) {
            throw ("A .p12 key does not contain the service account's email address. " +
                   "Set DRIVE_SA_CLIENT_EMAIL (or pass -ClientEmail) to the account's " +
                   "address, e.g. fleet-upload@<project>.iam.gserviceaccount.com")
        }

        $flags = [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::Exportable
        $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 `
            -ArgumentList $Path, $Password, $flags

        # GetRSAPrivateKey, not $cert.PrivateKey: the latter returns a legacy
        # RSACryptoServiceProvider on 5.1 whose SignData cannot do SHA-256 with
        # the older CSPs, which fails at the signature rather than at load time.
        $rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($cert)
        if ($null -eq $rsa) { throw "Could not read an RSA private key out of $Path" }

        return @{ Rsa = $rsa; ClientEmail = $ClientEmailOverride; Disposable = $cert }
    }

    throw "Unsupported key format '$extension'. Use a .json (PowerShell 7+) or .p12 key."
}

<#
  Mint an access token via the JWT-bearer flow.
  https://developers.google.com/identity/protocols/oauth2/service-account
#>
function Get-AccessToken {
    param(
        [Parameter(Mandatory = $true)] $Rsa,
        [Parameter(Mandatory = $true)][string] $ClientEmail,
        [Parameter(Mandatory = $true)][string] $Scope
    )

    $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    # 3600s is the documented MAXIMUM ("a maximum of 1 hour after the issued
    # time"), so it is used as the ceiling, not stretched past it.
    $exp = $now + 3600

    $header = @{ alg = 'RS256'; typ = 'JWT' } | ConvertTo-Json -Compress
    $claims = [ordered]@{
        iss   = $ClientEmail
        scope = $Scope
        aud   = $script:TokenEndpoint
        exp   = $exp
        iat   = $now
    } | ConvertTo-Json -Compress

    $signingInput = (ConvertTo-Base64UrlText -Text $header) + '.' + (ConvertTo-Base64UrlText -Text $claims)
    $signature = $Rsa.SignData(
        [System.Text.Encoding]::UTF8.GetBytes($signingInput),
        [System.Security.Cryptography.HashAlgorithmName]::SHA256,
        [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
    )
    $assertion = $signingInput + '.' + (ConvertTo-Base64Url -Bytes $signature)

    try {
        $response = Invoke-RestMethod -Method Post -Uri $script:TokenEndpoint -Body @{
            grant_type = 'urn:ietf:params:oauth:grant-type:jwt-bearer'
            assertion  = $assertion
        }
    } catch {
        # Google's error body names the actual cause ('invalid_grant' for a clock
        # skew or a wrong iss, 'unauthorized_client' for a scope problem). The
        # assertion itself is NEVER echoed -- it is a bearer credential.
        $detail = ''
        if ($_.Exception.Response) {
            $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
            $detail = $reader.ReadToEnd()
        }
        throw "Token request refused by Google. $detail"
    }

    return $response.access_token
}

# ---------------------------------------------------------------------------

if ([string]::IsNullOrWhiteSpace($FileId)) {
    throw "No -FileId given and DRIVE_FILE_ID is not set. This script updates one existing file and never creates one; see the notes at the top."
}
if ([string]::IsNullOrWhiteSpace($KeyPath)) {
    throw "No -KeyPath given and DRIVE_SA_KEY_PATH is not set."
}
if (-not (Test-Path -LiteralPath $CsvPath)) {
    throw "CSV not found: $CsvPath"
}

$csv = Get-Item -LiteralPath $CsvPath
if ($csv.Length -eq 0) {
    throw "$CsvPath is empty. Refusing to publish it -- the importer would reject it anyway, a day later and further from anyone who could fix it."
}
if ($csv.Length -gt $script:MaxCsvBytes) {
    throw "$CsvPath is $($csv.Length) bytes; the importer's limit is $script:MaxCsvBytes. Split the export."
}

# Cheap sanity check on shape. The importer requires a serialNumber column, so a
# file without one imports nothing -- better to say so here than in tomorrow's log.
$firstLine = Get-Content -LiteralPath $CsvPath -TotalCount 1
if ($firstLine -notmatch '(?i)serial') {
    Write-Warning "The first line of $CsvPath does not mention a serial column. The importer requires 'serialNumber'; this export may import zero rows."
}

Write-Step "Publishing $($csv.Name) ($($csv.Length) bytes) to Drive file $FileId"

$key = $null
try {
    $key = Get-ServiceAccountKey -Path $KeyPath -Password $KeyPassword -ClientEmailOverride $ClientEmail
    Write-Step "Authenticating as $($key.ClientEmail)"

    $token = Get-AccessToken -Rsa $key.Rsa -ClientEmail $key.ClientEmail -Scope $Scope
    $authHeader = @{ Authorization = "Bearer $token" }

    # Confirm the target exists and is reachable BEFORE uploading. A 404 here is
    # the normal symptom of the file not being shared with the service account,
    # and it is far clearer to fail on a metadata read than mid-upload.
    $meta = Invoke-RestMethod -Method Get -Headers $authHeader `
        -Uri "https://www.googleapis.com/drive/v3/files/$FileId`?fields=id,name,size,modifiedTime"
    Write-Step "Target: '$($meta.name)', last modified $($meta.modifiedTime)"

    if (-not $PSCmdlet.ShouldProcess("Drive file $FileId ('$($meta.name)')", "Replace contents with $($csv.Name)")) {
        Write-Step "-WhatIf: validated the key, the token and access to the file. Nothing was written."
        return
    }

    $updated = Invoke-RestMethod -Method Patch `
        -Uri "https://www.googleapis.com/upload/drive/v3/files/$FileId`?uploadType=media&fields=id,name,size,modifiedTime" `
        -Headers $authHeader `
        -ContentType 'text/csv' `
        -InFile $csv.FullName

    Write-Step "Done. $($updated.size) bytes now live, modified $($updated.modifiedTime)."
    Write-Step "The file ID is unchanged, so the app's DRIVE_CSV_URL still resolves."
}
finally {
    if ($null -ne $key -and $null -ne $key.Disposable) { $key.Disposable.Dispose() }
}
