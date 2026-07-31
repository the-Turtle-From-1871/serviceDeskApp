<#
.SYNOPSIS
  Shared state, config and logging for the Gmail refresh-token rotation tool.

.DESCRIPTION
  Every other module in this folder depends on this one and on nothing else in it.
  Config lives outside the repository, under %LOCALAPPDATA%, with every secret member
  held as a SecureString so Export-CliXml encrypts it with DPAPI -- bound to this Windows
  user on this machine, and useless if the file is copied elsewhere.

  No secret is ever written to the log, the state file, the console, or a toast.

  Windows PowerShell 5.1. No ternary, no ??, no pipeline chain operators.
#>

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$script:AppFolderName = 'dcsim-gmail-rotation'
$script:MaxLogBytes = 1MB
$script:MaxLogGenerations = 3

# Google issues a 7-day refresh token to Testing-status projects. Everything the
# scheduler decides is measured against this constant.
$script:TokenLifetimeDays = 7

function Get-RotationRoot {
    <#
    .SYNOPSIS
      Absolute path to the per-user data folder, created on first use.
    #>
    [CmdletBinding()]
    param()

    $root = Join-Path $env:LOCALAPPDATA $script:AppFolderName
    if (-not (Test-Path -LiteralPath $root)) {
        New-Item -ItemType Directory -Path $root -Force | Out-Null
    }
    return $root
}

function Get-RotationConfigPath { return (Join-Path (Get-RotationRoot) 'config.xml') }
function Get-RotationStatePath  { return (Join-Path (Get-RotationRoot) 'state.json') }
function Get-RotationLogPath    { return (Join-Path (Get-RotationRoot) 'rotate.log') }

function ConvertFrom-SecureStringPlain {
    <#
    .SYNOPSIS
      Decrypt a SecureString to a plain String, freeing the unmanaged buffer.
    .NOTES
      Call this as late as possible and never store the result. It exists because
      Invoke-RestMethod bodies and URLs need plain text.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory = $true)]
        [System.Security.SecureString] $Secure
    )

    $bstr = [System.IntPtr]::Zero
    try {
        $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
        return [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    }
    finally {
        if ($bstr -ne [System.IntPtr]::Zero) {
            [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        }
    }
}

function Save-RotationConfig {
    <#
    .SYNOPSIS
      Persist the config hashtable, DPAPI-encrypting its SecureString members.
    .PARAMETER Config
      Hashtable with these keys. Secret members MUST already be SecureString:
        ClientId        [string]
        ClientSecret    [SecureString]
        VercelToken     [SecureString]
        VercelProjectId [string]
        VercelTeamId    [string] or $null   ($null for a personal account)
        DeployHookUrl   [SecureString]      (the URL embeds a secret key)
        EnvVarName      [string]            (default 'GMAIL_REFRESH_TOKEN')
        EnvTarget       [string]            (default 'production')
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [hashtable] $Config
    )

    foreach ($key in @('ClientSecret', 'VercelToken', 'DeployHookUrl')) {
        if (-not $Config.ContainsKey($key)) {
            throw "Config is missing required secret '$key'."
        }
        if ($Config[$key] -isnot [System.Security.SecureString]) {
            throw "Config member '$key' must be a SecureString, got [$($Config[$key].GetType().Name)]."
        }
    }
    foreach ($key in @('ClientId', 'VercelProjectId')) {
        if ([string]::IsNullOrWhiteSpace([string]$Config[$key])) {
            throw "Config is missing required value '$key'."
        }
    }

    if (-not $Config.ContainsKey('EnvVarName') -or [string]::IsNullOrWhiteSpace([string]$Config['EnvVarName'])) {
        $Config['EnvVarName'] = 'GMAIL_REFRESH_TOKEN'
    }
    if (-not $Config.ContainsKey('EnvTarget') -or [string]::IsNullOrWhiteSpace([string]$Config['EnvTarget'])) {
        $Config['EnvTarget'] = 'production'
    }
    # setup.ps1 constrains this at the prompt, but a config written before that guard existed
    # -- or by hand -- can still hold e.g. 'prod', which Vercel rejects only AFTER the user
    # has completed a consent click. Refuse it at the point of persistence too, so there is
    # one place that cannot be bypassed.
    $validTargets = @('production', 'preview', 'development')
    $Config['EnvTarget'] = ([string]$Config['EnvTarget']).Trim().ToLowerInvariant()
    if ($validTargets -notcontains $Config['EnvTarget']) {
        throw "EnvTarget must be one of: $($validTargets -join ', '). Got '$($Config['EnvTarget'])'."
    }
    if (-not $Config.ContainsKey('VercelTeamId')) { $Config['VercelTeamId'] = $null }

    $path = Get-RotationConfigPath
    $Config | Export-Clixml -Path $path -Force

    # Belt and braces on top of DPAPI: strip inherited ACEs so only this user can read it.
    try {
        $acl = Get-Acl -LiteralPath $path
        $acl.SetAccessRuleProtection($true, $false)
        $acl.Access | ForEach-Object { $acl.RemoveAccessRule($_) | Out-Null }
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
            "$env:USERDOMAIN\$env:USERNAME", 'FullControl', 'Allow')
        $acl.AddAccessRule($rule)
        Set-Acl -LiteralPath $path -AclObject $acl
    }
    catch {
        Write-RotationLog -Level 'WARN' -Message "Could not tighten ACL on config.xml: $($_.Exception.Message)"
    }
}

function Get-RotationConfig {
    <#
    .SYNOPSIS
      Load the config. Throws a actionable error when setup has not been run.
    #>
    [CmdletBinding()]
    param()

    $path = Get-RotationConfigPath
    if (-not (Test-Path -LiteralPath $path)) {
        throw "No configuration at '$path'. Run setup.ps1 first."
    }
    return (Import-Clixml -Path $path)
}

function Get-RotationState {
    <#
    .SYNOPSIS
      Load rotation state, returning a zero-value object when none exists yet.
    .OUTPUTS
      PSCustomObject with every member always present:
        lastSuccessAt      when a rotation last SUCCEEDED. The token age is measured from
                           this and nothing else.
        lastAttemptAt      when a rotation was last TRIED, successful or not.
        expiresAt          lastSuccessAt + 7 days.
        lastResult         'ok' | 'failed' | $null
        lastError          message from the last failure, or $null
        lastDeploymentUrl  from the last successful deploy
      Timestamps are ISO 8601 strings or $null. A fresh install has all-null and is
      therefore treated as maximally overdue by Get-TokenAgeDays.
      A pre-split state file (one `lastRotatedAt` field) is migrated on read.
    #>
    [CmdletBinding()]
    param()

    $path = Get-RotationStatePath
    $empty = [pscustomobject]@{
        lastSuccessAt     = $null
        lastAttemptAt     = $null
        expiresAt         = $null
        lastResult        = $null
        lastError         = $null
        lastDeploymentUrl = $null
    }
    if (-not (Test-Path -LiteralPath $path)) { return $empty }

    try {
        $raw = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
    }
    catch {
        # A corrupt state file must not wedge rotation; treat it as "never rotated".
        Write-RotationLog -Level 'WARN' -Message "state.json unreadable, treating as empty: $($_.Exception.Message)"
        return $empty
    }

    # An EMPTY file (or a literal `null`) makes ConvertFrom-Json return $null WITHOUT
    # throwing, so the catch above never fires. Under StrictMode 2.0 the normalize loop
    # below would then fault on $null.PSObject, and that fault escapes this function -- so
    # every Check run would crash into the last-resort handler and Save-RotationState could
    # never repair the file. A zero-byte state.json would permanently wedge the tool.
    if ($null -eq $raw) {
        Write-RotationLog -Level 'WARN' -Message 'state.json was empty; treating as never rotated.'
        return $empty
    }

    # Normalize to the full member set. StrictMode 2.0 makes a missing property a
    # terminating error at the point of USE, which would be a confusing crash a long way
    # from the cause -- so every member is materialized here, once.
    $out = $empty.PSObject.Copy()
    foreach ($name in @('lastSuccessAt', 'lastAttemptAt', 'expiresAt', 'lastResult', 'lastError', 'lastDeploymentUrl')) {
        if ($raw.PSObject.Properties.Name -contains $name) { $out.$name = $raw.$name }
    }

    # Migrate a pre-split state file. `lastRotatedAt` used to mean both "when we last tried"
    # and "when we last succeeded", which is the bug this split exists to fix; the old value
    # is only trustworthy as a success stamp when the run it recorded actually succeeded.
    if ($null -eq $out.lastSuccessAt -and ($raw.PSObject.Properties.Name -contains 'lastRotatedAt')) {
        $out.lastAttemptAt = $raw.lastRotatedAt
        if (($raw.PSObject.Properties.Name -contains 'lastResult') -and $raw.lastResult -eq 'ok') {
            $out.lastSuccessAt = $raw.lastRotatedAt
        }
    }
    return $out
}

function Save-RotationState {
    <#
    .SYNOPSIS
      Persist rotation state. Never call this with a token value in any field.
    .DESCRIPTION
      `lastSuccessAt` and `lastAttemptAt` are SEPARATE and must stay that way.
      A failed attempt moves `lastAttemptAt` and leaves `lastSuccessAt` alone, because the
      token that is live in production is still the one from the last SUCCESS and it is
      still aging on its original clock. Collapsing them into one stamp -- as an earlier
      version did -- meant a single cancelled consent made the tool report "outbound mail
      is DOWN" every six hours forever, on a token with days of life left. That false alarm
      on a benign path is precisely what teaches an operator to ignore the notification
      this whole tool exists to deliver.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)] [datetime] $AttemptedAt,
        [Parameter(Mandatory = $true)] [ValidateSet('ok', 'failed')] [string] $Result,
        [Parameter(Mandatory = $false)] [string] $ErrorMessage = $null,
        [Parameter(Mandatory = $false)] [string] $DeploymentUrl = $null
    )

    $prior = Get-RotationState
    $attemptStamp = $AttemptedAt.ToUniversalTime().ToString('o')

    # Carry the prior success forward on failure; only a success moves it.
    $successStamp = $prior.lastSuccessAt
    $expiresStamp = $prior.expiresAt
    $deployUrl = $prior.lastDeploymentUrl
    if ($Result -eq 'ok') {
        $successStamp = $attemptStamp
        $expiresStamp = $AttemptedAt.ToUniversalTime().AddDays($script:TokenLifetimeDays).ToString('o')
        $deployUrl = $DeploymentUrl
    }

    $state = [pscustomobject]@{
        lastSuccessAt     = $successStamp
        lastAttemptAt     = $attemptStamp
        expiresAt         = $expiresStamp
        lastResult        = $Result
        lastError         = $ErrorMessage
        lastDeploymentUrl = $deployUrl
    }
    # Write via a temp file and replace, so a crash or power loss mid-write leaves the OLD
    # state intact rather than a half-written or zero-byte one. Set-Content truncates first,
    # which is exactly the window that produces the empty file guarded against on read.
    $target = Get-RotationStatePath
    $temp = "$target.tmp"
    $state | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $temp -Encoding UTF8
    Move-Item -LiteralPath $temp -Destination $target -Force
    return $state
}

function Get-TokenAgeDays {
    <#
    .SYNOPSIS
      Age in days of the last SUCCESSFUL rotation.
    .DESCRIPTION
      Measured from `lastSuccessAt` ONLY. A failed attempt must not affect this: the token
      live in production is still the one from the last success, still aging on its own
      clock, and quite possibly still fine. Reading the failure into the age is what made
      one cancelled consent latch a permanent "outbound mail is DOWN" alarm.

      Returns [double]::PositiveInfinity only when there has never been a successful
      rotation, so a caller's threshold comparison lands in the most urgent bucket without
      needing a null check. Callers that need to tell "never succeeded" apart from "expired
      long ago" must test `lastSuccessAt` for null themselves -- the two are different
      events and deserve different wording.
    #>
    [CmdletBinding()]
    [OutputType([double])]
    param(
        [Parameter(Mandatory = $false)] $State = $null,
        [Parameter(Mandatory = $false)] [datetime] $Now = (Get-Date)
    )

    if ($null -eq $State) { $State = Get-RotationState }
    if ($null -eq $State.lastSuccessAt) {
        return [double]::PositiveInfinity
    }

    try {
        $last = [datetime]::Parse(
            $State.lastSuccessAt, $null,
            [System.Globalization.DateTimeStyles]::RoundtripKind)
    }
    catch {
        return [double]::PositiveInfinity
    }

    $age = ($Now.ToUniversalTime() - $last.ToUniversalTime()).TotalDays
    # A future stamp is clock skew, not a fresh token; clamp rather than trust it.
    if ($age -lt 0) { return 0 }
    return $age
}

function Write-RotationLog {
    <#
    .SYNOPSIS
      Append a line to the rolling log. Rolls at 1 MB, keeping 3 generations.
    .NOTES
      Callers must never pass a token, client secret or hook URL in -Message.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $false)] [ValidateSet('INFO', 'WARN', 'ERROR')] [string] $Level = 'INFO',
        [Parameter(Mandatory = $true)] [string] $Message
    )

    $path = Get-RotationLogPath
    try {
        if ((Test-Path -LiteralPath $path) -and ((Get-Item -LiteralPath $path).Length -gt $script:MaxLogBytes)) {
            for ($i = $script:MaxLogGenerations - 1; $i -ge 1; $i--) {
                $older = "$path.$i"
                $newer = "$path.$($i + 1)"
                if (Test-Path -LiteralPath $older) { Move-Item -LiteralPath $older -Destination $newer -Force }
            }
            Move-Item -LiteralPath $path -Destination "$path.1" -Force
        }
        $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
        Add-Content -LiteralPath $path -Value "$stamp [$Level] $Message" -Encoding UTF8
    }
    catch {
        # Logging must never be the reason a rotation fails.
        Write-Verbose "Log write failed: $($_.Exception.Message)"
    }
}

Export-ModuleMember -Function @(
    'Get-RotationRoot'
    'Get-RotationConfigPath'
    'Get-RotationStatePath'
    'Get-RotationLogPath'
    'ConvertFrom-SecureStringPlain'
    'Save-RotationConfig'
    'Get-RotationConfig'
    'Get-RotationState'
    'Save-RotationState'
    'Get-TokenAgeDays'
    'Write-RotationLog'
)
