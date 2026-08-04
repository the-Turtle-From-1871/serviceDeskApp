<#
.SYNOPSIS
  One-time interactive installer for the Gmail refresh-token rotation tool.

.DESCRIPTION
  Collects the OAuth and Vercel configuration, stores it DPAPI-encrypted under
  %LOCALAPPDATA% (see Common.psm1), then installs the Windows plumbing that makes
  the every-3-days consent click convenient and unmissable: a Start Menu shortcut
  carrying the AppUserModelID, the dcsim-gmail-rotate: protocol handler, and a
  scheduled task that runs `rotate-gmail-token.ps1 -Mode Check` every 6 hours.

  Everything is PER-USER -- HKCU, %APPDATA%, %LOCALAPPDATA% and a task in the
  interactive user's context. Do NOT run this elevated: an elevated run would store
  the DPAPI-encrypted config under the ADMINISTRATOR's profile and register the
  task for that account, so the everyday login would find no config and never be
  notified.

  Secrets are never echoed, logged, or written anywhere except the encrypted config.

  Every value can be supplied three ways. Each is tried in this order, and the first
  one that has a value wins:

    1. A PARAMETER on this script.
    2. An ENVIRONMENT VARIABLE (see the table below).
    3. The value already in the config, if any.

  Anything still missing is PROMPTED for, unless -NonInteractive, which fails instead
  and names the parameter and environment variable that would have supplied it.

  | Setting          | Parameter          | Environment variable              |
  | ---------------- | ------------------ | --------------------------------- |
  | OAuth client id  | -ClientId          | DCSIM_ROTATION_CLIENT_ID          |
  | OAuth secret     | -ClientSecret      | DCSIM_ROTATION_CLIENT_SECRET      |
  | Vercel token     | -VercelToken       | DCSIM_ROTATION_VERCEL_TOKEN       |
  | Vercel project   | -VercelProjectId   | DCSIM_ROTATION_VERCEL_PROJECT_ID  |
  | Vercel team      | -VercelTeamId      | DCSIM_ROTATION_VERCEL_TEAM_ID     |
  | Deploy hook URL  | -DeployHookUrl     | DCSIM_ROTATION_DEPLOY_HOOK_URL    |
  | Env var name     | -EnvVarName        | DCSIM_ROTATION_ENV_VAR_NAME       |
  | Env target       | -EnvTarget         | DCSIM_ROTATION_ENV_TARGET         |

  SECRETS: the three secret PARAMETERS are [SecureString], deliberately. A secret
  typed as a plain argument is written to PSReadLine's ConsoleHost_history.txt and is
  visible in the process command line to anything that can enumerate processes, so
  passing one that way leaks it to disk and to other users. For unattended use prefer
  the ENVIRONMENT VARIABLES, which appear in neither. They are read once and are not
  retained.

.PARAMETER NonInteractive
  Never prompt. Fail with a message naming the missing setting instead. Use for
  scripted installs.

.PARAMETER Uninstall
  Remove the scheduled task, protocol handler and Start Menu shortcut. Asks before
  deleting the stored config and state (unless -Force). The log is always kept.

.PARAMETER Force
  Do not ask for confirmation before overwriting an existing config. With
  -Uninstall, also deletes config and state without asking.

.EXAMPLE
  .\setup.ps1
  Prompts for everything, as before.

.EXAMPLE
  .\setup.ps1 -DeployHookUrl (Read-Host 'hook' -AsSecureString)
  Supply one value, keep the rest from the existing config without retyping.

.EXAMPLE
  $env:DCSIM_ROTATION_VERCEL_TOKEN = 'vcp_...'
  .\setup.ps1 -ClientId '123.apps.googleusercontent.com' -VercelProjectId 'prj_...' -NonInteractive
  Unattended. Secrets come from the environment, never the command line.
#>

[CmdletBinding()]
param(
    [string] $ClientId,
    [System.Security.SecureString] $ClientSecret,
    [System.Security.SecureString] $VercelToken,
    [string] $VercelProjectId,
    [string] $VercelTeamId,
    [System.Security.SecureString] $DeployHookUrl,
    [string] $EnvVarName,
    [ValidateSet('production', 'preview', 'development')]
    [string] $EnvTarget,
    [switch] $NonInteractive,
    [switch] $Uninstall,
    [switch] $Force
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'Common.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'WindowsIntegration.psm1') -Force

# --------------------------------------------------------------------------------
# Console helpers
# --------------------------------------------------------------------------------

# Every prompt below re-asks until it gets a usable answer. That is right at a real
# console and catastrophic without one: when stdin is redirected to a pipe or the null
# device, Read-Host returns empty INSTANTLY and forever, so the re-ask becomes a hot
# infinite loop printing "A value is required." until something kills it. Read-Host
# -AsSecureString cannot work in that context either -- it needs a console to mask input.
# So refuse up front with an actionable message rather than spinning.
$script:MaxPromptAttempts = 25

function Assert-InteractiveConsole {
    <#
    .SYNOPSIS
      Refuse to run without a real console, before anything is prompted for or written.
    #>
    if ([Console]::IsInputRedirected) {
        Write-Host ''
        Write-Host 'setup.ps1 needs an interactive console.' -ForegroundColor Red
        Write-Host ''
        Write-Host 'Standard input is redirected, so the prompts cannot be answered and the' -ForegroundColor Yellow
        Write-Host 'secret prompts cannot mask what you type. Nothing has been changed.' -ForegroundColor Yellow
        Write-Host ''
        Write-Host 'Open a PowerShell window (Win+X, then Terminal) and run:' -ForegroundColor Cyan
        Write-Host '    cd C:\inventoryApp\scripts\gmail-token-rotation' -ForegroundColor Cyan
        Write-Host '    .\setup.ps1' -ForegroundColor Cyan
        Write-Host ''
        exit 2
    }
}

function Assert-PromptProgress {
    <#
    .SYNOPSIS
      Backstop for a prompt loop that is getting nowhere.
    .DESCRIPTION
      Assert-InteractiveConsole catches the common case. This catches the rest -- a host
      that reports a console but still returns nothing, for instance -- so no loop in this
      script can spin without bound.
    #>
    param(
        [Parameter(Mandatory = $true)][int] $Attempt,
        [Parameter(Mandatory = $true)][string] $What
    )
    if ($Attempt -ge $script:MaxPromptAttempts) {
        throw "Gave up after $script:MaxPromptAttempts attempts reading '$What' -- the console is not returning input. Nothing has been changed. Run setup.ps1 from an interactive PowerShell window."
    }
}

function Write-Heading {
    param([Parameter(Mandatory = $true)][string] $Text)
    Write-Host ''
    Write-Host $Text -ForegroundColor Cyan
    Write-Host ('-' * $Text.Length) -ForegroundColor DarkCyan
}

function Write-Note {
    param([Parameter(Mandatory = $true)][string] $Text)
    Write-Host "  $Text" -ForegroundColor DarkGray
}

function Read-YesNo {
    <#
    .SYNOPSIS
      Ask a yes/no question. Returns [bool]. Empty input takes -DefaultYes.
    #>
    param(
        [Parameter(Mandatory = $true)][string] $Question,
        [switch] $DefaultYes
    )

    if ($DefaultYes) { $suffix = '[Y/n]' } else { $suffix = '[y/N]' }
    $attempt = 0

    while ($true) {
        $attempt++
        Assert-PromptProgress -Attempt $attempt -What $Question
        $answer = Read-Host "$Question $suffix"
        if ([string]::IsNullOrWhiteSpace($answer)) {
            return [bool]$DefaultYes
        }
        $answer = $answer.Trim().ToLowerInvariant()
        if ($answer -eq 'y' -or $answer -eq 'yes') { return $true }
        if ($answer -eq 'n' -or $answer -eq 'no') { return $false }
        Write-Host '  Please answer y or n.' -ForegroundColor Yellow
    }
}

function Read-PlainValue {
    <#
    .SYNOPSIS
      Prompt for a non-secret string, offering an existing/default value that Enter
      keeps.
    .NOTES
      Only ever used for values that are NOT credentials, so echoing the current
      value back is safe and lets the user confirm it is right.
    #>
    param(
        [Parameter(Mandatory = $true)][string] $Prompt,
        [Parameter(Mandatory = $false)][string] $Current = $null,
        [switch] $AllowBlank
    )

    $hasCurrent = -not [string]::IsNullOrWhiteSpace($Current)
    $attempt = 0

    while ($true) {
        $attempt++
        Assert-PromptProgress -Attempt $attempt -What $Prompt
        if ($hasCurrent) {
            $entered = Read-Host "$Prompt (Enter keeps '$Current')"
        }
        elseif ($AllowBlank) {
            $entered = Read-Host "$Prompt (Enter for none)"
        }
        else {
            $entered = Read-Host $Prompt
        }

        if ([string]::IsNullOrWhiteSpace($entered)) {
            if ($hasCurrent) { return $Current }
            if ($AllowBlank) { return $null }
            Write-Host '  A value is required.' -ForegroundColor Yellow
            continue
        }

        return $entered.Trim()
    }
}

function Read-ChoiceValue {
    <#
    .SYNOPSIS
      Prompt for a value that MUST be one of -Allowed, re-prompting until it is.
    .DESCRIPTION
      Matching is case-insensitive (PowerShell's -eq on strings) but the ALLOWED spelling
      is what gets returned, so "Production" is accepted and stored as "production" --
      the only form Vercel's API and VercelApi.psm1's own ValidateSet accept.
    .PARAMETER Current
      The existing/stored value. It is VALIDATED too, not trusted: the bad value is
      typically already sitting in the config file, and offering "Enter keeps 'prod'"
      would launder it straight back in.
    .NOTES
      Why this is not just Read-PlainValue: a free-text target was accepted here, echoed
      back by -Verify as part of "All checks passed", and only rejected by
      VercelApi.psm1's ValidateSet -- at the END of a rotation, AFTER the operator had
      already completed the one consent click the whole tool exists to collect. Rejecting
      at the point of entry is the only place the mistake costs nothing.

      Re-prompting rather than throwing matches every other prompt in this script, and
      -Force does not suppress prompts (it only skips confirmations), so there is no
      unattended path this can wedge.
    #>
    param(
        [Parameter(Mandatory = $true)][string] $Prompt,
        [Parameter(Mandatory = $true)][string[]] $Allowed,
        [Parameter(Mandatory = $false)][string] $Current = $null
    )

    $allowedText = $Allowed -join ', '

    # Canonicalize the stored value, or refuse it out loud.
    $canonical = $null
    if (-not [string]::IsNullOrWhiteSpace($Current)) {
        $trimmedCurrent = $Current.Trim()
        foreach ($candidate in $Allowed) {
            if ($candidate -eq $trimmedCurrent) { $canonical = $candidate; break }
        }
        if ($null -eq $canonical) {
            Write-Host "  The stored value '$trimmedCurrent' is not valid (must be one of: $allowedText)." -ForegroundColor Yellow
            Write-Note 'It cannot be kept -- enter a valid value.'
        }
    }

    $attempt = 0
    while ($true) {
        $attempt++
        Assert-PromptProgress -Attempt $attempt -What $Prompt
        if ($null -ne $canonical) {
            $entered = Read-Host "$Prompt (Enter keeps '$canonical')"
        }
        else {
            $entered = Read-Host $Prompt
        }

        if ([string]::IsNullOrWhiteSpace($entered)) {
            if ($null -ne $canonical) { return $canonical }
            Write-Host "  A value is required. Enter one of: $allowedText." -ForegroundColor Yellow
            continue
        }

        $entered = $entered.Trim()
        foreach ($candidate in $Allowed) {
            if ($candidate -eq $entered) { return $candidate }
        }
        Write-Host "  '$entered' is not one of: $allowedText." -ForegroundColor Yellow
    }
}

function Read-SecretValue {
    <#
    .SYNOPSIS
      Prompt for a secret as a SecureString, offering "Enter keeps the existing one".
    .NOTES
      The secret is never rendered, not even masked, and never leaves this function
      as plain text. An empty entry means "unchanged" -- which is the only reason
      re-running setup does not force the operator to re-paste every credential.
    #>
    param(
        [Parameter(Mandatory = $true)][string] $Prompt,
        [Parameter(Mandatory = $false)][System.Security.SecureString] $Current = $null
    )

    $hasCurrent = ($null -ne $Current -and $Current.Length -gt 0)
    $attempt = 0

    while ($true) {
        $attempt++
        Assert-PromptProgress -Attempt $attempt -What $Prompt
        if ($hasCurrent) {
            $entered = Read-Host "$Prompt (Enter keeps the stored value)" -AsSecureString
        }
        else {
            $entered = Read-Host $Prompt -AsSecureString
        }

        if ($null -ne $entered -and $entered.Length -gt 0) {
            return $entered
        }

        if ($hasCurrent) {
            Write-Note 'Keeping the stored value.'
            return $Current
        }

        Write-Host '  A value is required.' -ForegroundColor Yellow
    }
}

function Resolve-Setting {
    <#
    .SYNOPSIS
      Resolve one non-secret setting: parameter, then environment, then existing config,
      then prompt. Honours -NonInteractive by failing instead of prompting.
    #>
    param(
        [Parameter(Mandatory = $true)][string] $Prompt,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string] $ParamValue,
        [Parameter(Mandatory = $true)][string] $EnvName,
        [Parameter(Mandatory = $false)][AllowEmptyString()][string] $Current = '',
        [Parameter(Mandatory = $false)][string[]] $Allowed = $null,
        [switch] $AllowBlank
    )

    $value = $null
    $source = $null
    if (-not [string]::IsNullOrWhiteSpace($ParamValue)) {
        $value = $ParamValue.Trim(); $source = 'parameter'
    }
    else {
        $fromEnv = [Environment]::GetEnvironmentVariable($EnvName)
        if (-not [string]::IsNullOrWhiteSpace($fromEnv)) { $value = $fromEnv.Trim(); $source = "`$env:$EnvName" }
    }

    if ($null -ne $value) {
        if ($null -ne $Allowed -and $Allowed -notcontains $value) {
            throw "$Prompt was given as '$value' via $source, which is not one of: $($Allowed -join ', ')."
        }
        Write-Host ("  {0}: {1}  (from {2})" -f $Prompt, $value, $source)
        return $value
    }

    if ($script:NonInteractiveMode) {
        if ($AllowBlank) { return $null }
        if (-not [string]::IsNullOrWhiteSpace($Current)) {
            Write-Host ("  {0}: kept from the existing config" -f $Prompt)
            return $Current
        }
        throw "$Prompt was not supplied and -NonInteractive is set. Pass it as a parameter or set `$env:$EnvName."
    }

    if ($null -ne $Allowed) {
        return (Read-ChoiceValue -Prompt $Prompt -Allowed $Allowed -Current $Current)
    }
    return (Read-PlainValue -Prompt $Prompt -Current $Current -AllowBlank:$AllowBlank)
}

function Resolve-Secret {
    <#
    .SYNOPSIS
      Resolve one secret: SecureString parameter, then environment variable, then the
      stored value, then prompt. Honours -NonInteractive by failing instead of prompting.
    .NOTES
      An environment variable arrives as plain text; it is converted immediately and the
      plain copy is not retained. It is NOT cleared from the caller's environment -- that
      is the caller's to manage, and clearing it would surprise a script setting several.
    #>
    param(
        [Parameter(Mandatory = $true)][string] $Prompt,
        [Parameter(Mandatory = $false)][System.Security.SecureString] $ParamValue = $null,
        [Parameter(Mandatory = $true)][string] $EnvName,
        [Parameter(Mandatory = $false)][System.Security.SecureString] $Current = $null
    )

    if ($null -ne $ParamValue -and $ParamValue.Length -gt 0) {
        Write-Host ("  {0}: supplied as a parameter" -f $Prompt)
        return $ParamValue
    }

    $fromEnv = [Environment]::GetEnvironmentVariable($EnvName)
    if (-not [string]::IsNullOrWhiteSpace($fromEnv)) {
        Write-Host ("  {0}: read from `$env:{1}" -f $Prompt, $EnvName)
        return (ConvertTo-SecureString $fromEnv.Trim() -AsPlainText -Force)
    }

    if ($script:NonInteractiveMode) {
        if ($null -ne $Current -and $Current.Length -gt 0) {
            Write-Host ("  {0}: kept from the existing config" -f $Prompt)
            return $Current
        }
        throw "$Prompt was not supplied and -NonInteractive is set. Pass it as a [SecureString] parameter or set `$env:$EnvName."
    }

    return (Read-SecretValue -Prompt $Prompt -Current $Current)
}

function Get-ExistingConfigOrNull {
    <#
    .SYNOPSIS
      Load the config if there is one, else $null. Never throws.
    #>
    param()

    if (-not (Test-Path -LiteralPath (Get-RotationConfigPath))) { return $null }
    try {
        return (Get-RotationConfig)
    }
    catch {
        Write-Host "  Existing config could not be read ($($_.Exception.Message)); it will be replaced." -ForegroundColor Yellow
        return $null
    }
}

function Get-ConfigMember {
    <#
    .SYNOPSIS
      Read a key from a loaded config, tolerating both hashtable and PSObject
      shapes and a missing key. Returns $null when absent.
    .NOTES
      Set-StrictMode 2.0 makes a bare property access on a missing key throw, and
      Import-Clixml can hand back either shape, so every read goes through here.
    #>
    param(
        [Parameter(Mandatory = $false)] $Config,
        [Parameter(Mandatory = $true)][string] $Name
    )

    if ($null -eq $Config) { return $null }

    if ($Config -is [hashtable]) {
        if ($Config.ContainsKey($Name)) { return $Config[$Name] }
        return $null
    }

    $property = $Config.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

# --------------------------------------------------------------------------------
# Uninstall
# --------------------------------------------------------------------------------

function Invoke-Uninstall {
    param([switch] $Unattended)

    Write-Heading 'Removing the Windows integration'

    $removed = Unregister-RotationIntegration
    if ($null -eq $removed -or @($removed).Count -eq 0) {
        Write-Note 'Nothing was registered.'
    }
    else {
        foreach ($item in @($removed)) { Write-Host "  Removed $item." }
    }

    $configPath = Get-RotationConfigPath
    $statePath  = Get-RotationStatePath
    $logPath    = Get-RotationLogPath

    $hasData = (Test-Path -LiteralPath $configPath) -or (Test-Path -LiteralPath $statePath)

    if ($hasData) {
        Write-Heading 'Stored credentials and state'
        Write-Note "Config: $configPath"
        Write-Note "State:  $statePath"

        if ($Unattended) {
            $deleteData = $true
        }
        else {
            $deleteData = Read-YesNo 'Delete the stored config and rotation state as well?'
        }

        if ($deleteData) {
            if (Test-Path -LiteralPath $configPath) { Remove-Item -LiteralPath $configPath -Force }
            if (Test-Path -LiteralPath $statePath)  { Remove-Item -LiteralPath $statePath -Force }
            Write-Host '  Deleted config and state.'
        }
        else {
            Write-Host '  Kept config and state. Re-running setup.ps1 will reuse them.'
        }
    }

    # The log is never deleted here: it is the record of what this tool did, and
    # nothing in it is sensitive.
    Write-Host ''
    Write-Host 'Uninstall complete.' -ForegroundColor Green
    Write-Note "The log was left at $logPath"
}

# --------------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------------

Write-Host ''
Write-Host '=== DCSIM Gmail token rotation - setup ===' -ForegroundColor White

$script:NonInteractiveMode = [bool]$NonInteractive

# Before ANYTHING is prompted for or written. Without a console every prompt reads EOF
# instantly and the re-ask loops spin; this turns that into an immediate, actionable exit.
# Skipped under -NonInteractive, which is the whole point of that switch: every value
# comes from a parameter, the environment or the existing config, so no console is needed
# and a redirected stdin is expected rather than a fault.
if (-not $script:NonInteractiveMode) { Assert-InteractiveConsole }

# An elevated run silently installs into the wrong profile, so say so loudly.
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = (New-Object System.Security.Principal.WindowsPrincipal($identity)).IsInRole(
    [System.Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin) {
    Write-Host ''
    Write-Host 'WARNING: this session is elevated.' -ForegroundColor Yellow
    Write-Note 'Nothing here needs administrator rights. Installing from an elevated'
    Write-Note 'session stores the config under the elevated profile and registers the'
    Write-Note 'task for that account, so your everyday login would never be notified.'
    Write-Note 'Run this from a normal, non-elevated PowerShell window instead.'
    # -NonInteractive cannot ask, and must not silently proceed with an install that lands
    # in the wrong profile -- that failure is invisible until nobody is ever notified.
    # Refuse instead, and say -Force is the deliberate override.
    if ($script:NonInteractiveMode -and -not $Force) {
        throw 'Refusing to install from an elevated session under -NonInteractive: the config would be stored under the elevated profile and the everyday login would never be notified. Re-run without elevation, or pass -Force if this is deliberate.'
    }
    if (-not $Force) {
        if (-not (Read-YesNo 'Continue anyway?')) {
            Write-Host 'Aborted.' -ForegroundColor Yellow
            return
        }
    }
}

if ($Uninstall) {
    Invoke-Uninstall -Unattended:$Force
    return
}

if (-not (Test-Path -LiteralPath (Get-RotationScriptPath))) {
    throw "Cannot find the orchestrator at '$(Get-RotationScriptPath)'. Run setup.ps1 from the folder it lives in."
}

$existing = Get-ExistingConfigOrNull

if ($null -ne $existing) {
    Write-Host ''
    Write-Host "An existing configuration was found at $(Get-RotationConfigPath)." -ForegroundColor Yellow
    Write-Note 'Press Enter at any prompt to keep the stored value.'
    # -NonInteractive proceeds without asking: updating an existing config is the ordinary
    # case for a scripted re-run, and the resolver keeps every value it was not given.
    if (-not $Force -and -not $script:NonInteractiveMode) {
        if (-not (Read-YesNo 'Update it?' -DefaultYes)) {
            Write-Host 'Aborted. Nothing was changed.' -ForegroundColor Yellow
            return
        }
    }
}

# ---- Google OAuth -------------------------------------------------------------

Write-Heading 'Google OAuth client'
Write-Note 'These come from the OAuth client JSON you downloaded from the Google Cloud'
Write-Note 'console. Create the credential as an application type of "Desktop app" --'
Write-Note 'a Web application client will refuse the loopback redirect this tool uses.'
Write-Note 'In the JSON they are the "client_id" and "client_secret" fields.'

$clientId = Resolve-Setting -Prompt 'OAuth client id' -ParamValue $ClientId `
                            -EnvName 'DCSIM_ROTATION_CLIENT_ID' `
                            -Current ([string](Get-ConfigMember -Config $existing -Name 'ClientId'))
$clientSecret = Resolve-Secret -Prompt 'OAuth client secret' -ParamValue $ClientSecret `
                               -EnvName 'DCSIM_ROTATION_CLIENT_SECRET' `
                               -Current (Get-ConfigMember -Config $existing -Name 'ClientSecret')

# ---- Vercel -------------------------------------------------------------------

Write-Heading 'Vercel'
Write-Note 'API token: Vercel dashboard -> Account Settings -> Tokens.'
Write-Note 'Project id: Project Settings -> General ("prj_..."). '
Write-Note 'Team id: Team Settings -> General ("team_..."). Leave blank for a'
Write-Note 'personal (hobby) account that is not in a team.'

$vercelToken = Resolve-Secret -Prompt 'Vercel API token' -ParamValue $VercelToken `
                              -EnvName 'DCSIM_ROTATION_VERCEL_TOKEN' `
                              -Current (Get-ConfigMember -Config $existing -Name 'VercelToken')
$vercelProjectId = Resolve-Setting -Prompt 'Vercel project id' -ParamValue $VercelProjectId `
                                   -EnvName 'DCSIM_ROTATION_VERCEL_PROJECT_ID' `
                                   -Current ([string](Get-ConfigMember -Config $existing -Name 'VercelProjectId'))

$existingTeamId = [string](Get-ConfigMember -Config $existing -Name 'VercelTeamId')
$vercelTeamId = Resolve-Setting -Prompt 'Vercel team id' -ParamValue $VercelTeamId `
                                -EnvName 'DCSIM_ROTATION_VERCEL_TEAM_ID' `
                                -Current $existingTeamId -AllowBlank
if ([string]::IsNullOrWhiteSpace([string]$vercelTeamId)) {
    # Common.psm1 expects a real $null, not an empty string, for a personal account.
    $vercelTeamId = $null
}

Write-Heading 'Deploy hook'
Write-Note 'Project Settings -> Git -> Deploy Hooks. The URL embeds a secret key, so it'
Write-Note 'is stored encrypted and never printed back.'

$deployHookUrl = Resolve-Secret -Prompt 'Deploy hook URL' -ParamValue $DeployHookUrl `
                                -EnvName 'DCSIM_ROTATION_DEPLOY_HOOK_URL' `
                                -Current (Get-ConfigMember -Config $existing -Name 'DeployHookUrl')

# ---- Environment variable -----------------------------------------------------

Write-Heading 'Environment variable to update'

$existingEnvVarName = [string](Get-ConfigMember -Config $existing -Name 'EnvVarName')
if ([string]::IsNullOrWhiteSpace($existingEnvVarName)) { $existingEnvVarName = 'GMAIL_REFRESH_TOKEN' }

$existingEnvTarget = [string](Get-ConfigMember -Config $existing -Name 'EnvTarget')
if ([string]::IsNullOrWhiteSpace($existingEnvTarget)) { $existingEnvTarget = 'production' }

$envVarName = Resolve-Setting -Prompt 'Environment variable name' -ParamValue $EnvVarName `
                              -EnvName 'DCSIM_ROTATION_ENV_VAR_NAME' -Current $existingEnvVarName

# Constrained, not free text. Vercel accepts exactly these three, and a typo here would
# otherwise survive setup, survive -Verify, and only fail after the consent click.
$envTarget = Resolve-Setting -Prompt 'Environment target (production / preview / development)' `
                             -ParamValue $EnvTarget -EnvName 'DCSIM_ROTATION_ENV_TARGET' `
                             -Allowed @('production', 'preview', 'development') `
                             -Current $existingEnvTarget

# ---- Save ---------------------------------------------------------------------

Write-Heading 'Saving configuration'

$config = @{
    ClientId        = $clientId
    ClientSecret    = $clientSecret
    VercelToken     = $vercelToken
    VercelProjectId = $vercelProjectId
    VercelTeamId    = $vercelTeamId
    DeployHookUrl   = $deployHookUrl
    EnvVarName      = $envVarName
    EnvTarget       = $envTarget
}

Save-RotationConfig -Config $config
Write-Host "  Saved (DPAPI-encrypted) to $(Get-RotationConfigPath)"
Write-RotationLog -Level 'INFO' -Message 'Configuration saved by setup.ps1.'

# ---- Windows integration ------------------------------------------------------

Write-Heading 'Installing the Windows integration'

$shortcutPath = Register-RotationShortcut
Write-Host "  Start Menu shortcut: $shortcutPath"

$handlerKey = Register-RotationProtocolHandler
Write-Host "  Protocol handler:    $handlerKey"

Register-RotationScheduledTask | Out-Null
$status = Get-RotationIntegrationStatus
Write-Host '  Scheduled task:      \DCSIM\Gmail Token Rotation Check (every 6 hours)'
if ($null -eq $status.NextRunTime) {
    Write-Host '  Next run:            not scheduled yet'
}
else {
    Write-Host "  Next run:            $($status.NextRunTime)"
}

if (-not $status.TaskRegistered -or -not $status.HandlerRegistered -or -not $status.ShortcutExists) {
    Write-Host ''
    Write-Host 'WARNING: part of the integration did not register.' -ForegroundColor Yellow
    Write-Note "Task: $($status.TaskRegistered)  Handler: $($status.HandlerRegistered)  Shortcut: $($status.ShortcutExists)"
}

# ---- Next steps ---------------------------------------------------------------

Write-Heading 'Next steps'
Write-Host '  1. Check the credentials work end to end:' -ForegroundColor White
Write-Host '       .\rotate-gmail-token.ps1 -Verify'
Write-Host ''
Write-Host '  2. Seed the first token (this opens Google and needs one click):' -ForegroundColor White
Write-Host '       .\rotate-gmail-token.ps1 -Mode Rotate'
Write-Host ''
Write-Host '  From then on the scheduled task checks every 6 hours and raises a toast'
Write-Host '  when the token is close to expiring. Click "Rotate now" on the toast --'
Write-Host '  or the Start Menu entry "DCSIM Gmail Token Rotation" -- to rotate.'
Write-Host ''
Write-Note 'Google issues a 7-day refresh token while the OAuth project is in Testing,'
Write-Note 'so the consent click is needed roughly every 3 days. It cannot be automated.'
Write-Note "Log: $(Get-RotationLogPath)"
Write-Note 'To remove everything again: .\setup.ps1 -Uninstall'
Write-Host ''
Write-Host 'Setup complete.' -ForegroundColor Green
