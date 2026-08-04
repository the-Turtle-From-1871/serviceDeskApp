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

  Secrets are read with Read-Host -AsSecureString and are never echoed, logged, or
  written anywhere except the encrypted config.

.PARAMETER Uninstall
  Remove the scheduled task, protocol handler and Start Menu shortcut. Asks before
  deleting the stored config and state (unless -Force). The log is always kept.

.PARAMETER Force
  Do not ask for confirmation before overwriting an existing config. With
  -Uninstall, also deletes config and state without asking.

.EXAMPLE
  .\setup.ps1

.EXAMPLE
  .\setup.ps1 -Uninstall
#>

[CmdletBinding()]
param(
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

    while ($true) {
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

    while ($true) {
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

    while ($true) {
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

    while ($true) {
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
    if (-not $Force) {
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

$clientId     = Read-PlainValue  -Prompt 'OAuth client id' -Current ([string](Get-ConfigMember -Config $existing -Name 'ClientId'))
$clientSecret = Read-SecretValue -Prompt 'OAuth client secret' -Current (Get-ConfigMember -Config $existing -Name 'ClientSecret')

# ---- Vercel -------------------------------------------------------------------

Write-Heading 'Vercel'
Write-Note 'API token: Vercel dashboard -> Account Settings -> Tokens.'
Write-Note 'Project id: Project Settings -> General ("prj_..."). '
Write-Note 'Team id: Team Settings -> General ("team_..."). Leave blank for a'
Write-Note 'personal (hobby) account that is not in a team.'

$vercelToken     = Read-SecretValue -Prompt 'Vercel API token' -Current (Get-ConfigMember -Config $existing -Name 'VercelToken')
$vercelProjectId = Read-PlainValue  -Prompt 'Vercel project id' -Current ([string](Get-ConfigMember -Config $existing -Name 'VercelProjectId'))

$existingTeamId = [string](Get-ConfigMember -Config $existing -Name 'VercelTeamId')
$vercelTeamId = Read-PlainValue -Prompt 'Vercel team id' -Current $existingTeamId -AllowBlank
if ([string]::IsNullOrWhiteSpace([string]$vercelTeamId)) {
    # Common.psm1 expects a real $null, not an empty string, for a personal account.
    $vercelTeamId = $null
}

Write-Heading 'Deploy hook'
Write-Note 'Project Settings -> Git -> Deploy Hooks. The URL embeds a secret key, so it'
Write-Note 'is stored encrypted and never printed back.'

$deployHookUrl = Read-SecretValue -Prompt 'Deploy hook URL' -Current (Get-ConfigMember -Config $existing -Name 'DeployHookUrl')

# ---- Environment variable -----------------------------------------------------

Write-Heading 'Environment variable to update'

$existingEnvVarName = [string](Get-ConfigMember -Config $existing -Name 'EnvVarName')
if ([string]::IsNullOrWhiteSpace($existingEnvVarName)) { $existingEnvVarName = 'GMAIL_REFRESH_TOKEN' }

$existingEnvTarget = [string](Get-ConfigMember -Config $existing -Name 'EnvTarget')
if ([string]::IsNullOrWhiteSpace($existingEnvTarget)) { $existingEnvTarget = 'production' }

$envVarName = Read-PlainValue -Prompt 'Environment variable name' -Current $existingEnvVarName

# Constrained, not free text. Vercel accepts exactly these three, and a typo here would
# otherwise survive setup, survive -Verify, and only fail after the consent click.
$envTarget = Read-ChoiceValue -Prompt 'Environment target (production / preview / development)' `
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
