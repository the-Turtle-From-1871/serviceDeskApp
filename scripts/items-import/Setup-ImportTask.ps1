<#
.SYNOPSIS
  One-time setup: store the import secret and register the Scheduled Task that
  imports the newest items*.csv from Downloads.

.DESCRIPTION
  Run this once. It does three things:

    1. Creates C:\ops\items-import\ and restricts it to this Windows account.
    2. Prompts for MDM_IMPORT_SECRET and stores it DPAPI-encrypted, so the value
       never enters the repository -- scripts/ is committed and pushed, and this
       secret authenticates a WRITE endpoint into the production property book.
    3. Registers a Scheduled Task that polls Downloads every few minutes.

  INTERACTIVE BY DEFAULT, S4U WHEN INTERACTIVE IS REFUSED. Interactive ("only
  when the user is logged on") stores no Windows password, and nothing is lost by
  it: the event this reacts to is the user downloading a file, which requires them
  to be logged on anyway.

  Some machines refuse to launch an Interactive task at all, returning
  0x800710E0 on both the natural trigger and an on-demand start. There, register
  with -LogonType S4U from an ELEVATED prompt.

  DPAPI DOES WORK UNDER S4U -- verified 2026-08-11. This script used to claim the
  opposite (that S4U could not reach the user's DPAPI master key, so the secret
  would fail to decrypt). That was a prediction and it was wrong: the S4U task
  launched, decrypted secret.txt, and made an authenticated request. Do not avoid
  S4U on DPAPI grounds. If some other machine genuinely cannot decrypt, set
  MDM_IMPORT_SECRET as a machine-level environment variable -- the worker prefers
  the environment variable over the file.

  WHY POLLING. A successful import deletes the CSV, so "an items*.csv exists" is
  itself the new-file signal. A poll that finds nothing makes no network request.

  Windows PowerShell 5.1 compatible: no ternary, no ??, no && / ||.

.PARAMETER IntervalMinutes
  Poll cadence. Default 5.

.PARAMETER Secret
  Supply the secret non-interactively instead of being prompted.

.PARAMETER BaseUrl
  App origin to import into. Default https://www.dcsim.us. Stored on the task's
  command line only if you override it.

.PARAMETER Unregister
  Remove the Scheduled Task. Leaves C:\ops\items-import\ and the stored secret.

.PARAMETER Test
  Run one import immediately, keeping the CSV, and stop. Does not register
  anything. This is DEPLOY.md section 7a step 2 -- run it twice to confirm the
  import is idempotent.

.EXAMPLE
  .\Setup-ImportTask.ps1

.EXAMPLE
  # Prove it works before scheduling anything (keeps the file):
  .\Setup-ImportTask.ps1 -Test

.EXAMPLE
  .\Setup-ImportTask.ps1 -Unregister
#>
[CmdletBinding()]
param(
    [int] $IntervalMinutes = 5,

    [string] $Secret,

    [string] $BaseUrl,

    [string] $StateDir = 'C:\ops\items-import',

    [string] $TaskName = 'InventoryApp Items CSV Import',

    # Interactive is the default. S4U additionally runs while logged off, still
    # stores no password, and DOES decrypt the DPAPI secret (verified
    # 2026-08-11) -- but it REQUIRES an elevated shell to register. Switch to it
    # when an Interactive task is refused with 0x800710E0.
    [ValidateSet('Interactive', 'S4U')]
    [string] $LogonType = 'Interactive',

    [switch] $Unregister,

    [switch] $Test
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:SecretPath = Join-Path $StateDir 'secret.txt'
$script:Worker = Join-Path $PSScriptRoot 'Import-ItemsCsv.ps1'
$script:Shim = Join-Path $PSScriptRoot 'Run-Hidden.vbs'

function Write-Step { param([string] $Message) Write-Host "[setup] $Message" }

if (-not (Test-Path -LiteralPath $script:Worker)) {
    throw "Import-ItemsCsv.ps1 was not found next to this script ($($script:Worker))."
}
if (-not (Test-Path -LiteralPath $script:Shim)) {
    throw "Run-Hidden.vbs was not found next to this script ($($script:Shim))."
}

# ---------------------------------------------------------------------------
# Unregister
# ---------------------------------------------------------------------------

if ($Unregister) {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -eq $existing) {
        Write-Step "No task named '$TaskName' is registered. Nothing to do."
        exit 0
    }
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Step "Removed the Scheduled Task '$TaskName'."
    Write-Step "$StateDir and the stored secret were left alone -- delete them by hand if you want them gone."
    exit 0
}

# ---------------------------------------------------------------------------
# State directory + secret
# ---------------------------------------------------------------------------

if (-not (Test-Path -LiteralPath $StateDir)) {
    New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
    Write-Step "Created $StateDir"
}

<#
  Restrict the folder to this account, SYSTEM and Administrators, and stop
  inheriting from C:\. Best-effort: DPAPI is the real protection on the secret,
  so a failure here is a warning rather than a stop.
#>
$aclAlreadyDone = $false
try {
    # Cheap read first, OUTSIDE the write path: if the folder is already
    # protected there is nothing to do, and doing it anyway is actively harmful.
    # Set-Acl writes back every section Get-Acl handed over, including the SACL,
    # and writing a SACL needs SeSecurityPrivilege, which a normal non-elevated
    # shell does not hold. That is why the first run succeeded and every run
    # after it printed a "could not tighten permissions" warning about a folder
    # that was already correctly restricted.
    $aclAlreadyDone = (Get-Acl -LiteralPath $StateDir).AreAccessRulesProtected
} catch {
    $aclAlreadyDone = $false
}

if ($aclAlreadyDone) {
    Write-Step "$StateDir is already restricted; leaving its permissions as they are."
} else {
    try {
        $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
        $acl = Get-Acl -LiteralPath $StateDir
        # $true = protect from inheritance, $false = do NOT copy the inherited rules down.
        $acl.SetAccessRuleProtection($true, $false)

        $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
        $none = [System.Security.AccessControl.PropagationFlags]::None

        # The WellKnownSidType enum, NOT the 'SY'/'BA' SDDL aliases. Passing a
        # two-character string plus $null binds to the SecurityIdentifier(byte[], int)
        # overload and dies with "Cannot convert value "SY" to type "System.Byte[]"".
        $system = New-Object System.Security.Principal.SecurityIdentifier(
            [System.Security.Principal.WellKnownSidType]::LocalSystemSid, $null)
        $admins = New-Object System.Security.Principal.SecurityIdentifier(
            [System.Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid, $null)

        foreach ($who in @($identity.User, $system, $admins)) {
            $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
                $who, 'FullControl', $inherit, $none, 'Allow')))
        }

        Set-Acl -LiteralPath $StateDir -AclObject $acl
        Write-Step "Restricted $StateDir to $($identity.Name), SYSTEM and Administrators."
    } catch {
        # Best-effort: DPAPI is the real protection on the secret, so this is a
        # warning rather than a stop.
        Write-Warning "Could not tighten permissions on $StateDir ($($_.Exception.Message)). The secret is still DPAPI-encrypted."
    }
}

$haveSecret = Test-Path -LiteralPath $script:SecretPath

if (-not [string]::IsNullOrWhiteSpace($Secret)) {
    $secure = ConvertTo-SecureString -String $Secret -AsPlainText -Force
    ConvertFrom-SecureString -SecureString $secure | Set-Content -LiteralPath $script:SecretPath -Encoding UTF8
    Write-Step "Stored the supplied secret (DPAPI-encrypted) in $($script:SecretPath)."
} elseif (-not $haveSecret) {
    Write-Host ''
    Write-Host 'Paste MDM_IMPORT_SECRET -- the same value set in Vercel for Production.' -ForegroundColor Cyan
    Write-Host 'It is stored encrypted to this Windows account only, never in the repository.' -ForegroundColor Cyan
    $secure = Read-Host -Prompt 'MDM_IMPORT_SECRET' -AsSecureString
    if ($secure.Length -eq 0) {
        throw 'No secret entered. Re-run this script; without it every import returns 401.'
    }
    ConvertFrom-SecureString -SecureString $secure | Set-Content -LiteralPath $script:SecretPath -Encoding UTF8
    Write-Step "Stored the secret (DPAPI-encrypted) in $($script:SecretPath)."
} else {
    Write-Step "A secret is already stored in $($script:SecretPath). Pass -Secret to replace it."
}

# ---------------------------------------------------------------------------
# Test run
# ---------------------------------------------------------------------------

if ($Test) {
    Write-Host ''
    Write-Step 'Running one import now, keeping the CSV. Nothing has been scheduled.'
    Write-Host ''

    # A HASHTABLE, not an array. Array splatting passes its elements as
    # POSITIONAL arguments, so @('-KeepFile') bound the literal string
    # "-KeepFile" to the worker's first positional parameter ($CsvPath) and the
    # test run died with `CSV not found: -KeepFile`. Only hashtable splatting
    # binds by parameter name; a switch is passed as $true.
    $testArgs = @{ KeepFile = $true }
    if (-not [string]::IsNullOrWhiteSpace($BaseUrl)) { $testArgs['BaseUrl'] = $BaseUrl }
    if ($StateDir -ne 'C:\ops\items-import') { $testArgs['StateDir'] = $StateDir }

    & $script:Worker @testArgs
    $code = $LASTEXITCODE

    Write-Host ''
    if ($code -eq 0) {
        Write-Step 'Test run finished. Run it once more to confirm the import is idempotent'
        Write-Step '(the second run should report added=0 updated=0), then re-run without -Test to schedule it.'
    } else {
        Write-Step "Test run exited $code. Fix that before scheduling anything."
    }
    exit $code
}

# ---------------------------------------------------------------------------
# Register the task
# ---------------------------------------------------------------------------

$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

# wscript.exe + Run-Hidden.vbs rather than powershell.exe directly: an
# Interactive task otherwise flashes a console window on every poll. The shim
# passes PowerShell's exit code back, so Last Run Result stays meaningful.
$workerArgs = "-Quiet"
if (-not [string]::IsNullOrWhiteSpace($BaseUrl)) { $workerArgs = "$workerArgs -BaseUrl `"$BaseUrl`"" }
if ($StateDir -ne 'C:\ops\items-import') { $workerArgs = "$workerArgs -StateDir `"$StateDir`"" }

$argument = "//nologo `"$($script:Shim)`" `"$($script:Worker)`" $workerArgs"
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument $argument

# TWO triggers, deliberately.
#
# An -AtLogOn trigger does NOT fire when the task is registered -- it fires at the
# next logon, and its repetition only begins when the trigger itself fires. On its
# own, registering this while already logged on would leave the whole cycle
# dormant until the next sign-in, while the task sat there looking perfectly
# healthy. So:
#
#   * the -Once trigger starts the repetition now and carries it indefinitely;
#   * the -AtLogOn trigger restarts the cycle cleanly at each later logon.
#
# `MultipleInstances IgnoreNew` below is what makes the overlap harmless.
#
# Assigning .Repetition across from a throwaway -Once trigger is also the only
# way to get a repetition onto an -AtLogOn trigger: New-ScheduledTaskTrigger will
# not accept -RepetitionInterval together with -AtLogOn.
$interval = New-TimeSpan -Minutes $IntervalMinutes

# +1 minute rather than (Get-Date): a start time already in the past makes Task
# Scheduler treat the first occurrence as missed, which -StartWhenAvailable then
# runs immediately anyway -- but the one-minute offset keeps NextRunTime readable
# instead of blank, which is the first thing anyone checks when debugging this.
$onceTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval $interval
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$logonTrigger.Repetition = $onceTrigger.Repetition

$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType $LogonType -RunLevel Limited

# AllowStartIfOnBatteries + DontStopIfGoingOnBatteries are NOT optional on a
# laptop: both default to the opposite, and without them the task silently never
# runs while unplugged -- which looks exactly like a broken importer.
# IgnoreNew stops a slow import (the endpoint allows itself up to 60s) from being
# re-entered by the next poll.
$settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

$description = "Imports the newest items*.csv from Downloads into the hand-receipt app " +
               "(POST /api/items/import) and deletes it. See scripts/items-import/README.md."

try {
    Register-ScheduledTask -TaskName $TaskName `
        -Action $action `
        -Trigger @($onceTrigger, $logonTrigger) `
        -Settings $settings `
        -Principal $principal `
        -Description $description `
        -Force | Out-Null
} catch {
    if ($LogonType -eq 'S4U') {
        throw ("Could not register the task: $($_.Exception.Message)`n" +
               "Registering an S4U task requires an ELEVATED PowerShell. Re-run this from an " +
               "Administrator prompt, or drop -LogonType S4U to use the default (Interactive).")
    }
    throw "Could not register the task: $($_.Exception.Message)"
}

Write-Host ''
Write-Step "Registered '$TaskName': every $IntervalMinutes minute(s), as $userId ($LogonType)."
Write-Step "Log: $(Join-Path $StateDir 'import.log')"

# ---------------------------------------------------------------------------
# Verify it can actually RUN, not just that it registered
# ---------------------------------------------------------------------------
#
# Registering always succeeds; executing is a separate question, and a task that
# registers cleanly but is refused at launch looks completely healthy in the
# Task Scheduler UI. So run it once here and report the real result.

Write-Host ''
Write-Step 'Running it once to confirm it can actually launch...'
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 12

$info = Get-ScheduledTaskInfo -TaskName $TaskName
$result = $info.LastTaskResult

# 0x41301 = still running, 0x41303 = has not run yet. Neither is a failure.
if ($result -eq 267009 -or $result -eq 267011) {
    Write-Step "Task is still running (result $result). Check the log in a moment."
} elseif ($result -eq 0) {
    Write-Step 'Confirmed: the task launched and the importer ran cleanly.'
} elseif ($result -eq 1) {
    Write-Step 'The task launched, but the import itself failed (exit 1).'
    Write-Step "That is a working schedule with a bad import -- read $(Join-Path $StateDir 'import.log')."
} elseif ($result -eq 2147946720) {
    # 0x800710E0 -- "The operator or administrator has refused the request."
    Write-Host ''
    Write-Warning ("The task registered but Windows REFUSED to launch it (0x800710E0).")
    Write-Host '  The task itself is configured correctly -- something on this machine is'
    Write-Host '  blocking scheduled tasks from starting a process in your session. Common causes:'
    Write-Host '    * you are on an RDP / remote session that Task Scheduler will not launch into;'
    Write-Host '    * endpoint security or Group Policy is blocking task-launched processes;'
    Write-Host '    * the account has "Log on as a batch job" denied.'
    Write-Host '  Try, in order:'
    Write-Host '    1. Run this from a normal desktop session (not RDP) and re-run setup.'
    Write-Host "    2. Register it as S4U from an ELEVATED prompt:  .\Setup-ImportTask.ps1 -LogonType S4U"
    Write-Host "  The importer itself is unaffected -- .\Import-ItemsCsv.ps1 works by hand either way."
} else {
    Write-Warning "The task launched with result $result. Check Task Scheduler's history for '$TaskName'."
}

Write-Host ''
Write-Step 'Drop an items*.csv in Downloads and it will be imported and removed within'
Write-Step "$IntervalMinutes minutes, with no window appearing."
Write-Step "Remove it later with:  .\Setup-ImportTask.ps1 -Unregister"
