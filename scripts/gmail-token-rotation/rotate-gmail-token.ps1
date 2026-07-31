<#
.SYNOPSIS
  Rotate the Gmail OAuth refresh token and redeploy Vercel production so it takes effect.

.DESCRIPTION
  The Google Cloud consent screen for this project is deliberately in "Testing" status,
  so Google issues refresh tokens that expire after 7 days. A refresh token CANNOT be
  renewed programmatically -- the 7-day clock is attached to the consent grant, not the
  token string, so recovering it requires a fresh authorization.

  Whether that authorization needs a human click is an open question the tool answers by
  measuring: it attempts a silent authorization first (prompt=none) and falls back to
  prompt=consent only when that returns no refresh token. Which path was used is logged
  and reported as UsedSilentPath. See section 1 of the design doc.

    Check   - run by the scheduled task every 6 hours; decides whether to nag, then exits.
    Rotate  - authorizes (silently if Google allows it), exchanges the code, writes the
              new token to Vercel production, redeploys, and waits for the build.

  See docs/superpowers/specs/2026-07-31-gmail-token-rotation-design.md.

.PARAMETER Mode
  Check  - evaluate token age and notify if due. Silent when nothing is needed.
  Rotate - perform the interactive rotation.

.PARAMETER Verify
  Read-only preflight: config completeness, Google client shape, Vercel reachability,
  scheduled-task registration. Mints nothing, changes nothing.

.PARAMETER DryRun
  With -Mode Rotate: perform the real OAuth flow and validation, then report the Vercel
  mutation and redeploy that WOULD have happened, without issuing either.
  Safe to run -- Google permits many concurrent refresh tokens per client, so minting one
  does not invalidate the token production is currently using.

.EXAMPLE
  .\rotate-gmail-token.ps1 -Verify
  .\rotate-gmail-token.ps1 -Mode Rotate

.NOTES
  Windows PowerShell 5.1. Run setup.ps1 once before using this.
#>

[CmdletBinding(DefaultParameterSetName = 'Run')]
param(
    [Parameter(ParameterSetName = 'Run')]
    [ValidateSet('Check', 'Rotate')]
    [string] $Mode = 'Check',

    [Parameter(ParameterSetName = 'Run')]
    [switch] $DryRun,

    [Parameter(Mandatory = $true, ParameterSetName = 'Verify')]
    [switch] $Verify
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'Common.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'GoogleOAuth.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'VercelApi.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'WindowsIntegration.psm1') -Force

# Notification thresholds, in days since the last SUCCESSFUL rotation. The token dies at 7.
# The task fires every 6h and these decide what it does -- a fixed 3-day trigger would miss
# its window whenever the machine sleeps through it, and fail silently.
$script:NagAfterDays      = 3
$script:UrgentAfterDays   = 5
$script:CriticalAfterDays = 7

function Get-UrgencyLevel {
    <#
    .SYNOPSIS
      Map token age to a notification level. 'None' means stay silent.
    #>
    param([Parameter(Mandatory = $true)] [double] $AgeDays)

    if ($AgeDays -ge $script:CriticalAfterDays) { return 'Critical' }
    if ($AgeDays -ge $script:UrgentAfterDays)   { return 'Warn' }
    if ($AgeDays -ge $script:NagAfterDays)      { return 'Info' }
    return 'None'
}

function Format-Remaining {
    <#
    .SYNOPSIS
      Human phrasing for how long the current token has left.
    #>
    param([Parameter(Mandatory = $true)] [double] $AgeDays)

    if ([double]::IsPositiveInfinity($AgeDays)) { return 'never rotated' }
    $hoursLeft = [math]::Round(($script:CriticalAfterDays - $AgeDays) * 24)
    if ($hoursLeft -le 0) { return 'already expired' }
    if ($hoursLeft -lt 48) { return "about $hoursLeft hours left" }
    return "about $([math]::Floor($hoursLeft / 24)) days left"
}

function Invoke-CheckMode {
    <#
    .SYNOPSIS
      Decide whether to notify. This is what the scheduled task runs every 6 hours.
    #>
    $state = Get-RotationState
    $age = Get-TokenAgeDays -State $state
    $level = Get-UrgencyLevel -AgeDays $age
    $remaining = Format-Remaining -AgeDays $age

    if ($level -eq 'None') {
        Write-RotationLog -Level 'INFO' -Message "Check: token age $([math]::Round($age, 2))d, $remaining. No action."
        return 0
    }

    $ageText = 'never'
    if (-not [double]::IsPositiveInfinity($age)) { $ageText = "$([math]::Round($age, 1)) days ago" }

    # A fresh install has never rotated, which scores Infinity and therefore Critical. It is
    # NOT the same event as an expired token: nothing has lapsed, mail is still going out
    # over whatever transport is configured, and saying "the token expired, mail is failing
    # now" would be a false alarm on day one. Seeding is a setup step, so say that instead.
    $neverRotated = ($null -eq $state.lastSuccessAt)

    if ($neverRotated) {
        # Downgrade the toast too -- Critical uses scenario="urgent", which pierces Focus
        # Assist. A pending setup step does not warrant that.
        $level = 'Info'
        $title = 'Gmail token rotation not set up yet'
        $body = 'Setup is done but no token has been minted. Click to run the first rotation and seed it.'
    }
    elseif ($level -eq 'Critical') {
        $title = 'Outbound mail is DOWN'
        $body = "The Gmail refresh token expired ($remaining). Receipt and alert email is failing now. Click to rotate."
    }
    elseif ($level -eq 'Warn') {
        $title = 'Gmail token expiring soon'
        $body = "Rotate now -- $remaining before outbound mail stops. Last rotated $ageText. Click to rotate."
    }
    else {
        $title = 'Gmail token rotation due'
        $body = "Last rotated $ageText, $remaining. Click to rotate -- a consent click at most, then a redeploy that runs on its own."
    }

    # Surface a previous failure rather than letting it look like a fresh nag.
    if ($null -ne $state.lastResult -and $state.lastResult -eq 'failed' -and -not [string]::IsNullOrWhiteSpace([string]$state.lastError)) {
        $body = "$body`nLast attempt failed: $($state.lastError)"
    }

    Write-RotationLog -Level 'WARN' -Message "Check: token age $([math]::Round($age, 2))d -> notifying at level $level."

    # Assigning (rather than Out-Null) does double duty. It keeps the [bool] out of this
    # function's output -- an uncaptured value would make `exit (Invoke-CheckMode)` receive
    # @($true, 0) and fail to cast to Int32 -- and it lets us ACT on the result. Windows
    # drops toasts silently when notifications are disabled for our AppUserModelID, so
    # without this check the tool goes invisibly mute while the token expires. Exiting
    # non-zero puts it in Task Scheduler's Last Run Result, which is the only place a
    # notification-less tool can still be noticed.
    $shown = Show-RotationToast -Level $level -Title $title -Message $body -Actionable
    if (-not $shown) {
        # $false means "nobody saw this", which is worth a non-zero exit whatever the cause
        # -- but do NOT assert the cause here. Show-RotationToast has already logged the
        # specific reason immediately above (notifications switched off for the app, a
        # deliberate deferral after self-healing the Start Menu shortcut, or a genuine
        # error), each with its own remedy. Naming one of them here would contradict that
        # line as often as it agreed with it.
        Write-RotationLog -Level 'ERROR' -Message 'Notification was NOT delivered -- the operator has not seen this warning. See the preceding log line for the reason and the remedy.'
        return 1
    }
    return 0
}

function Invoke-VerifyMode {
    <#
    .SYNOPSIS
      Read-only preflight. Reports rather than throws, so it can list several problems.
    #>
    $problems = New-Object System.Collections.Generic.List[string]

    Write-Host ''
    Write-Host 'Gmail token rotation -- verification' -ForegroundColor Cyan
    Write-Host ('-' * 44)

    try { $config = Get-RotationConfig }
    catch {
        Write-Host "  config          FAIL  $($_.Exception.Message)" -ForegroundColor Red
        Write-Host ''
        return 1
    }
    Write-Host "  config          OK    $(Get-RotationConfigPath)" -ForegroundColor Green

    # Save-RotationConfig refuses a bad EnvTarget now, but a config written before that guard
    # existed can still hold one. Catch it here rather than letting Vercel reject it AFTER
    # the user has completed a consent click -- reporting "All checks passed" on a value that
    # cannot work is worse than not checking at all.
    $validTargets = @('production', 'preview', 'development')
    if ($validTargets -notcontains ([string]$config.EnvTarget).Trim().ToLowerInvariant()) {
        Write-Host "  env target      FAIL  '$($config.EnvTarget)' is not one of: $($validTargets -join ', '). Re-run setup.ps1." -ForegroundColor Red
        $problems.Add("EnvTarget '$($config.EnvTarget)' is invalid.")
    }
    else {
        Write-Host "  env target      OK    $($config.EnvTarget)" -ForegroundColor Green
    }

    $google = Test-GoogleOAuthConfig -ClientId $config.ClientId -ClientSecret $config.ClientSecret
    if ($google.Ok) {
        Write-Host "  google client   OK    $($config.ClientId)" -ForegroundColor Green
    }
    else {
        Write-Host "  google client   FAIL  $($google.Message)" -ForegroundColor Red
        $problems.Add("Google client: $($google.Message)")
    }

    $teamId = $null
    if ($null -ne $config.VercelTeamId) { $teamId = [string]$config.VercelTeamId }

    $vercel = Test-VercelAccess -Token $config.VercelToken -ProjectId $config.VercelProjectId `
                                -TeamId $teamId -EnvVarName $config.EnvVarName
    if ($vercel.Ok) {
        Write-Host "  vercel access   OK    project '$($vercel.ProjectName)'" -ForegroundColor Green
        if ($vercel.EnvVarExists) {
            Write-Host "  env var         OK    $($config.EnvVarName) ($($config.EnvTarget))" -ForegroundColor Green
        }
        else {
            Write-Host "  env var         NOTE  $($config.EnvVarName) not set yet; first rotation will create it" -ForegroundColor Yellow
        }
    }
    else {
        Write-Host "  vercel access   FAIL  $($vercel.Message)" -ForegroundColor Red
        $problems.Add("Vercel: $($vercel.Message)")
    }

    $integration = Get-RotationIntegrationStatus
    if ($integration.TaskRegistered) {
        $next = 'unknown'
        if ($null -ne $integration.NextRunTime) { $next = $integration.NextRunTime.ToString('yyyy-MM-dd HH:mm') }
        Write-Host "  scheduled task  OK    next run $next" -ForegroundColor Green
    }
    else {
        Write-Host '  scheduled task  FAIL  not registered; re-run setup.ps1' -ForegroundColor Red
        $problems.Add('Scheduled task is not registered.')
    }

    if (-not $integration.HandlerRegistered) {
        Write-Host '  toast handler   WARN  protocol handler missing; toast button will not work' -ForegroundColor Yellow
    }

    $state = Get-RotationState
    $age = Get-TokenAgeDays -State $state
    Write-Host "  token age       $(Format-Remaining -AgeDays $age)"

    Write-Host ''
    if ($problems.Count -eq 0) {
        Write-Host 'All checks passed.' -ForegroundColor Green
        Write-Host ''
        return 0
    }
    Write-Host "$($problems.Count) problem(s) found." -ForegroundColor Red
    Write-Host ''
    return 1
}

function Invoke-RotateMode {
    <#
    .SYNOPSIS
      The real rotation. Nothing in production is touched until the new token has been
      obtained AND validated, so a cancelled consent is a clean no-op.
    #>
    param([switch] $IsDryRun)

    $config = Get-RotationConfig
    $startedAt = Get-Date

    if ($IsDryRun) { Write-Host 'DRY RUN -- Vercel will not be modified.' -ForegroundColor Yellow }

    # Deliberately hedged: the silent attempt may complete with no consent screen at all,
    # so promising "click Allow" up front would be wrong roughly half the time -- and if
    # the silent path turns out to work, wrong every time.
    Write-Host ''
    Write-Host 'Authorizing with Google. A browser window will open briefly.' -ForegroundColor Cyan
    Write-Host 'If a consent page appears, click "Allow" -- otherwise nothing is needed.' -ForegroundColor Cyan
    Write-Host ''
    Write-RotationLog -Level 'INFO' -Message 'Rotation started.'

    try {
        $token = Get-GoogleRefreshToken -ClientId $config.ClientId -ClientSecret $config.ClientSecret
    }
    catch {
        $message = $_.Exception.Message
        Write-RotationLog -Level 'ERROR' -Message "Consent/exchange failed: $message"
        Save-RotationState -AttemptedAt $startedAt -Result 'failed' -ErrorMessage $message | Out-Null
        Show-RotationToast -Level 'Warn' -Title 'Gmail token rotation failed' `
                           -Message "Consent or token exchange failed. Production was not changed.`n$message" -Actionable | Out-Null
        Write-Host "FAILED: $message" -ForegroundColor Red
        Write-Host 'Production was not modified.' -ForegroundColor Yellow
        return 1
    }

    # UsedSilentPath is the evidence that settles whether the consent click is necessary at
    # all (spec section 1), so report it to the operator as well as the log.
    if ($token.UsedSilentPath) {
        Write-Host 'New refresh token obtained silently -- no consent click was needed.' -ForegroundColor Green
    }
    else {
        Write-Host 'Consent granted; new refresh token obtained.' -ForegroundColor Green
    }
    Write-RotationLog -Level 'INFO' -Message "Refresh token obtained (silent path: $($token.UsedSilentPath)). Scopes granted: $($token.Scope)"

    $teamId = $null
    if ($null -ne $config.VercelTeamId) { $teamId = [string]$config.VercelTeamId }

    if ($IsDryRun) {
        Write-Host ''
        Write-Host 'Would have done:' -ForegroundColor Yellow
        Write-Host "  - set $($config.EnvVarName) on Vercel project $($config.VercelProjectId) [$($config.EnvTarget)]"
        Write-Host '  - fired the deploy hook and waited for the build'
        Write-Host ''
        Write-Host 'Dry run complete. The token just minted was discarded; production is unchanged.' -ForegroundColor Yellow
        Write-RotationLog -Level 'INFO' -Message 'Dry run complete; no Vercel mutation performed.'
        return 0
    }

    try {
        $envResult = Set-VercelEnvVar -Token $config.VercelToken -ProjectId $config.VercelProjectId `
                                      -TeamId $teamId -Name $config.EnvVarName `
                                      -Value $token.RefreshToken -Target $config.EnvTarget
        Write-Host "Vercel env var $($envResult.Action): $($config.EnvVarName)" -ForegroundColor Green
        Write-RotationLog -Level 'INFO' -Message "Vercel env var $($envResult.Action) (id $($envResult.EnvId))."

        $hook = Invoke-VercelDeployHook -HookUrl $config.DeployHookUrl
        Write-Host 'Redeploy triggered; waiting for the build.' -ForegroundColor Cyan
        Write-RotationLog -Level 'INFO' -Message "Deploy hook fired (job $($hook.JobId))."

        # -HookUrl is optional but must be passed: it lets the wait match meta.deployHookId
        # against this hook's own key exactly, instead of guessing "the oldest deployment
        # after Since". Without it, a teammate pushing to main at nearly the same moment can
        # be mistaken for our build -- and their build predates the env-var write, so it
        # carries the OLD token, reports READY, and we would record success while mail
        # quietly heads for an outage.
        $deployment = Wait-VercelDeployment -Token $config.VercelToken -ProjectId $config.VercelProjectId `
                                            -TeamId $teamId -Since $hook.RequestedAt -TimeoutMinutes 10 `
                                            -HookUrl $config.DeployHookUrl
    }
    catch {
        # The token is valid but did not reach production. Do NOT record success -- the next
        # Check must keep nagging, because the live token is still the old, dying one.
        $message = $_.Exception.Message
        Write-RotationLog -Level 'ERROR' -Message "Vercel step failed: $message"
        Save-RotationState -AttemptedAt $startedAt -Result 'failed' -ErrorMessage $message | Out-Null
        Show-RotationToast -Level 'Critical' -Title 'Gmail token rotation failed at Vercel' `
                           -Message "A new token was obtained but could not be deployed. Mail will stop when the old token expires.`n$message" -Actionable | Out-Null
        Write-Host "FAILED: $message" -ForegroundColor Red
        return 1
    }

    if ($deployment.State -eq 'READY') {
        Save-RotationState -AttemptedAt $startedAt -Result 'ok' -DeploymentUrl $deployment.Url | Out-Null
        Write-RotationLog -Level 'INFO' -Message "Rotation complete. Deployment READY after $($deployment.WaitedSeconds)s: $($deployment.Url)"
        Write-Host ''
        Write-Host "Done. Deployment ready: $($deployment.Url)" -ForegroundColor Green
        Write-Host "Next rotation due in $script:NagAfterDays days." -ForegroundColor Green
        Write-Host ''
        Show-RotationToast -Level 'Info' -Title 'Gmail token rotated' `
                           -Message "New token deployed. Next rotation due in $script:NagAfterDays days." | Out-Null
        return 0
    }

    if ($deployment.State -eq 'TIMEOUT') {
        # TIMEOUT means two very different things and they must not be conflated.
        #
        # A deployment WAS found and is merely slow: the env var is set, a build is running,
        # and it will almost certainly pick up the new token. Record success -- the rotation
        # did its job -- but say the build went unobserved.
        #
        # NO deployment was ever found: the hook did not produce a build. The env var is set
        # but nothing redeployed, so production is STILL SERVING THE OLD TOKEN and will keep
        # doing so until something else triggers a build. That is a failure, and recording it
        # as success would stop the 6-hourly nag on the one path where mail is heading for a
        # silent outage.
        if ([string]::IsNullOrWhiteSpace([string]$deployment.DeploymentId)) {
            # An empty DeploymentId covers two cases the module distinguishes in its own log
            # but cannot express through this contract: no deployment appeared at all, and a
            # deployment was matched but carried no usable id to track. Both mean the same
            # thing here -- we could not CONFIRM production rebuilt -- so the wording must
            # not assert the stronger "no build started", or the console will contradict the
            # log line sitting right above it.
            $noBuild = 'Env var was set but no deployment could be confirmed; production may still run the old token.'
            Save-RotationState -AttemptedAt $startedAt -Result 'failed' -ErrorMessage $noBuild | Out-Null
            Write-RotationLog -Level 'ERROR' -Message $noBuild
            Write-Host ''
            Write-Host 'The new token was written to Vercel, but the redeploy could not be confirmed.' -ForegroundColor Red
            Write-Host 'Production may still be running the OLD token. Check the Vercel dashboard: if no' -ForegroundColor Red
            Write-Host 'build is running, verify the deploy hook URL is correct and still enabled, then' -ForegroundColor Red
            Write-Host 'redeploy by hand. See rotate.log for which of the two cases this was.' -ForegroundColor Red
            Show-RotationToast -Level 'Critical' -Title 'Gmail token rotation did not confirm a deploy' `
                               -Message 'The token was saved but the redeploy could not be confirmed, so production may still have the old one. Check the Vercel dashboard.' -Actionable | Out-Null
            return 1
        }

        Save-RotationState -AttemptedAt $startedAt -Result 'ok' -DeploymentUrl $deployment.Url | Out-Null
        Write-RotationLog -Level 'WARN' -Message "Token deployed; build $($deployment.DeploymentId) still running at timeout."
        Write-Host ''
        Write-Host 'Token was written to Vercel and a redeploy was triggered, but the build did not' -ForegroundColor Yellow
        Write-Host 'finish within 10 minutes. Check the Vercel dashboard to confirm it succeeded.' -ForegroundColor Yellow
        Show-RotationToast -Level 'Warn' -Title 'Gmail token rotated, build unconfirmed' `
                           -Message 'The new token is in Vercel but the redeploy was still running. Check the dashboard.' | Out-Null
        return 0
    }

    $failMessage = "Deployment finished in state $($deployment.State)."
    Save-RotationState -AttemptedAt $startedAt -Result 'failed' -ErrorMessage $failMessage | Out-Null
    Write-RotationLog -Level 'ERROR' -Message $failMessage
    Show-RotationToast -Level 'Critical' -Title 'Gmail token rotation failed' `
                       -Message "$failMessage The new token is set but the deploy did not succeed." -Actionable | Out-Null
    Write-Host "FAILED: $failMessage" -ForegroundColor Red
    return 1
}

try {
    if ($Verify) { exit (Invoke-VerifyMode) }
    if ($Mode -eq 'Check') { exit (Invoke-CheckMode) }

    # Single-instance guard, Rotate only. The Start Menu shortcut and the toast button are
    # two doors to the same action, so starting it twice is easy -- and two concurrent
    # rotations mean two consent flows, two env-var writes and two production deploys, with
    # the loser's token overwriting the winner's. Check and Verify are read-only and may
    # overlap freely, so they are deliberately outside the guard.
    $mutex = New-Object System.Threading.Mutex($false, 'Local\dcsim-gmail-rotation-rotate')
    $held = $false
    try {
        $held = $mutex.WaitOne(0)
        if (-not $held) {
            Write-Host ''
            Write-Host 'A rotation is already running in another window. Finish that one first.' -ForegroundColor Yellow
            Write-RotationLog -Level 'WARN' -Message 'Rotate refused: another rotation is already in progress.'
            exit 1
        }
        exit (Invoke-RotateMode -IsDryRun:$DryRun)
    }
    finally {
        if ($held) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}
catch {
    # Last-resort guard. This path is reached by the TOAST-LAUNCHED route too, where the
    # console window closes the instant the process exits -- so a Write-Host here is
    # invisible and the user sees a flash and nothing else. An unreadable config (DPAPI
    # failure after a profile change, say) lands exactly here. Raise a toast so the failure
    # is visible, and tolerate the toast itself failing: this is the last-resort handler and
    # it must not throw.
    $message = $_.Exception.Message
    Write-RotationLog -Level 'ERROR' -Message "Unhandled: $message"
    Write-Host "Unhandled error: $message" -ForegroundColor Red
    try {
        Show-RotationToast -Level 'Critical' -Title 'Gmail token rotation crashed' `
                           -Message "The rotation failed before it could start. See rotate.log.`n$message" -Actionable | Out-Null
    }
    catch {
        Write-RotationLog -Level 'ERROR' -Message 'Could not raise a toast for the unhandled error.'
    }
    exit 1
}
