<#
.SYNOPSIS
  The entire Vercel side of the Gmail refresh-token rotation tool, over the Vercel REST API.

.DESCRIPTION
  Writes the rotated secret into a project environment variable, fires a deploy hook so a
  new build bakes it in, and waits for that build to finish. Nothing here knows what the
  secret IS -- no Google, no OAuth. The only sibling dependency is Common.psm1.

  Endpoints used (each verified against the live Vercel REST API reference, 2026-07-31):
    GET    https://api.vercel.com/v10/projects/{idOrName}/env
    POST   https://api.vercel.com/v10/projects/{idOrName}/env
    PATCH  https://api.vercel.com/v9/projects/{idOrName}/env/{id}      <- v9, NOT v10
    GET    https://api.vercel.com/v9/projects/{idOrName}
    GET    https://api.vercel.com/v7/deployments                       <- v7, NOT v6
    GET    https://api.vercel.com/v13/deployments/{idOrUrl}
    POST   https://api.vercel.com/v1/integrations/deploy/{projectId}/{key}   (deploy hook)

  Secrets discipline: the API token, the deploy hook URL and the environment variable's
  VALUE are never logged, never echoed and never allowed into a thrown message. Every
  Vercel response body is passed through Protect-Secret before it is logged or thrown.
  What does get logged: the variable NAME, the action taken, and the HTTP status.

  Windows PowerShell 5.1. No ternary, no ??, no pipeline chain operators.
#>

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# Imported WITHOUT -Force, deliberately. Inside a module, `Import-Module -Force` REMOVES the
# already-loaded copy and re-imports it as a NESTED module of this one -- which strips
# Common's functions from the importing script's scope. rotate-gmail-token.ps1 imports
# Common first, then this module; with -Force here, every Common function silently
# disappeared from the orchestrator and -Verify died on "Get-RotationConfig is not
# recognized". Without -Force this is a no-op when Common is already loaded, and a normal
# load when the module is used standalone.
Import-Module (Join-Path $PSScriptRoot 'Common.psm1')

# PS 5.1 can still negotiate SSL3/TLS1.0 by default; api.vercel.com requires TLS 1.2+.
if (([Net.ServicePointManager]::SecurityProtocol -band [Net.SecurityProtocolType]::Tls12) -ne [Net.SecurityProtocolType]::Tls12) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
}

$script:VercelApiBase = 'https://api.vercel.com'
$script:MaxAttempts = 4       # 1 initial attempt + 3 retries
$script:DefaultTimeoutSec = 60
$script:PollIntervalSec = 10
# Backdate applied to the deployment search window ONLY when an exact hook-id match is
# possible. See the asymmetry comment in Wait-VercelDeployment.
$script:HookMatchBackdateSeconds = 60


# ---------------------------------------------------------------------------
# Private helpers
# ---------------------------------------------------------------------------

function Protect-Secret {
    <#
    .SYNOPSIS
      Redact anything that looks like a credential out of text bound for a log or a throw.
    .NOTES
      Belt and braces. -Secrets carries values we KNOW are secret (the bearer token, the
      env var value); the regexes catch shapes we merely suspect, so a Vercel error body
      that happens to echo a value back cannot leak through.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory = $false)] [string] $Text,
        [Parameter(Mandatory = $false)] [string[]] $Secrets = @()
    )

    if ([string]::IsNullOrEmpty($Text)) { return '' }
    $out = $Text

    foreach ($s in $Secrets) {
        if (-not [string]::IsNullOrWhiteSpace($s) -and $s.Length -ge 8) {
            $out = $out.Replace($s, '<redacted>')
        }
    }

    # Deploy hook URLs embed a secret key in the path.
    $out = [regex]::Replace($out, '(?i)(/v1/integrations/deploy/)[^\s"'']+', '$1<redacted>')
    $out = [regex]::Replace($out, '(?i)(bearer\s+)[A-Za-z0-9._\-]+', '$1<redacted>')
    # Google token shapes, in case a caller ever hands us one by mistake.
    $out = [regex]::Replace($out, '1//[A-Za-z0-9._\-]{10,}', '<redacted>')
    $out = [regex]::Replace($out, '(?i)ya29\.[A-Za-z0-9._\-]{10,}', '<redacted>')
    # Anything long enough to be an opaque credential. Vercel ids (prj_/dpl_/env ids) are
    # shorter than 32 chars, so they survive and stay useful in a diagnostic.
    $out = [regex]::Replace($out, '(?<![A-Za-z0-9._\-])[A-Za-z0-9_\-]{32,}(?![A-Za-z0-9._\-])', '<redacted>')

    return $out
}

function Get-JsonProp {
    <#
    .SYNOPSIS
      Read a property off a ConvertFrom-Json object without tripping Set-StrictMode 2.0.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $false)] $Object,
        [Parameter(Mandatory = $true)] [string] $Name,
        [Parameter(Mandatory = $false)] $Default = $null
    )

    if ($null -eq $Object) { return $Default }
    try {
        $prop = $Object.PSObject.Properties[$Name]
        if ($null -eq $prop) { return $Default }
        if ($null -eq $prop.Value) { return $Default }
        return $prop.Value
    }
    catch {
        return $Default
    }
}

function Get-VercelStatusCode {
    <#
    .SYNOPSIS
      Integer HTTP status from a terminating Invoke-RestMethod error, or 0 if there was
      no HTTP response at all (DNS, TCP, TLS, timeout -- all treated as transient).
    #>
    [CmdletBinding()]
    [OutputType([int])]
    param([Parameter(Mandatory = $true)] $ErrorRecord)

    try {
        $response = $ErrorRecord.Exception.Response
        if ($null -ne $response) { return [int] $response.StatusCode }
    }
    catch { }
    return 0
}

function Get-VercelRetryAfterSeconds {
    <#
    .SYNOPSIS
      Retry-After header value in seconds, or 0 when absent/unparseable.
    #>
    [CmdletBinding()]
    [OutputType([int])]
    param([Parameter(Mandatory = $true)] $ErrorRecord)

    try {
        $response = $ErrorRecord.Exception.Response
        if ($null -eq $response) { return 0 }
        $raw = $response.Headers['Retry-After']
        if ([string]::IsNullOrWhiteSpace($raw)) { return 0 }
        $parsed = 0
        if ([int]::TryParse($raw, [ref] $parsed)) {
            if ($parsed -gt 0 -and $parsed -le 120) { return $parsed }
        }
    }
    catch { }
    return 0
}

function Get-VercelErrorBody {
    <#
    .SYNOPSIS
      Vercel's JSON error body as text. It names the real problem (e.g. a missing scope on
      the token) where the .NET exception message only says "(403) Forbidden".
    .NOTES
      Always scrub the result with Protect-Secret before logging or throwing it.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory = $true)] $ErrorRecord)

    $body = ''
    try {
        if ($null -ne $ErrorRecord.ErrorDetails) {
            $body = [string] $ErrorRecord.ErrorDetails.Message
        }
    }
    catch { }

    if ([string]::IsNullOrWhiteSpace($body)) {
        $reader = $null
        try {
            $response = $ErrorRecord.Exception.Response
            if ($null -ne $response) {
                $stream = $response.GetResponseStream()
                if ($null -ne $stream) {
                    $reader = New-Object System.IO.StreamReader($stream)
                    $body = $reader.ReadToEnd()
                }
            }
        }
        catch { }
        finally {
            if ($null -ne $reader) { $reader.Dispose() }
        }
    }

    if ($null -eq $body) { return '' }
    $body = $body.Trim()
    if ($body.Length -gt 1200) { $body = $body.Substring(0, 1200) + '...' }
    return $body
}

function New-VercelUrl {
    <#
    .SYNOPSIS
      Build an absolute api.vercel.com URL, appending only the query params that have a value.
    .NOTES
      teamId is omitted entirely when empty -- a personal-account token must not send
      teamId= at all, and an empty value is a 400, not a no-op.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory = $true)] [string] $Path,
        [Parameter(Mandatory = $false)] [hashtable] $Query = $null
    )

    $url = $script:VercelApiBase + $Path
    $parts = @()
    if ($null -ne $Query) {
        foreach ($key in $Query.Keys) {
            $value = $Query[$key]
            if ($null -eq $value) { continue }
            $text = [string] $value
            if ([string]::IsNullOrWhiteSpace($text)) { continue }
            $parts += ('{0}={1}' -f [uri]::EscapeDataString([string] $key), [uri]::EscapeDataString($text))
        }
    }
    if ($parts.Count -gt 0) { $url = $url + '?' + ($parts -join '&') }
    return $url
}

function Invoke-VercelApi {
    <#
    .SYNOPSIS
      One Vercel HTTP call with bounded retry and secret-scrubbed error reporting.
    .DESCRIPTION
      Retries HTTP 429, 5xx and transport-level failures (status 0) up to 3 times with
      2s/4s/8s exponential backoff, honouring Retry-After when Vercel sends one. A 4xx
      auth or validation error is NOT retried -- a bad token or a bad payload will not
      become good by waiting, and burning retries on it just delays the real message.

    .PARAMETER NonIdempotent
      Marks a request that may have taken effect even when we never saw a successful
      response. Suppresses retries for BOTH status 0 and 5xx (the two cases where the
      outcome is genuinely unknown), and appends the ambiguity to the thrown message.
      429 is already governed separately by -NoRetryOn429.
    .PARAMETER Description
      Short phrase naming the call, used in log lines and thrown messages. Never a secret.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)] [ValidateSet('GET', 'POST', 'PATCH', 'DELETE')] [string] $Method,
        [Parameter(Mandatory = $true)] [string] $Description,
        [Parameter(Mandatory = $false)] [string] $Path = $null,
        [Parameter(Mandatory = $false)] [string] $AbsoluteUrl = $null,
        [Parameter(Mandatory = $false)] [hashtable] $Query = $null,
        [Parameter(Mandatory = $false)] [string] $PlainToken = $null,
        [Parameter(Mandatory = $false)] $Body = $null,
        [Parameter(Mandatory = $false)] [string[]] $ScrubValues = @(),
        [Parameter(Mandatory = $false)] [int] $TimeoutSec = 0,
        [Parameter(Mandatory = $false)] [switch] $NoRetryOn429,
        [Parameter(Mandatory = $false)] [switch] $NonIdempotent
    )

    if ($TimeoutSec -le 0) { $TimeoutSec = $script:DefaultTimeoutSec }

    if (-not [string]::IsNullOrWhiteSpace($AbsoluteUrl)) {
        $url = $AbsoluteUrl
    }
    else {
        $url = New-VercelUrl -Path $Path -Query $Query
    }

    $scrub = @()
    $scrub += $ScrubValues
    if (-not [string]::IsNullOrWhiteSpace($PlainToken)) { $scrub += $PlainToken }
    $scrub += $url   # covers the deploy hook URL, whose path IS the secret

    $headers = @{ 'Accept' = 'application/json' }
    if (-not [string]::IsNullOrWhiteSpace($PlainToken)) {
        $headers['Authorization'] = 'Bearer ' + $PlainToken
    }

    $attempt = 0
    while ($true) {
        $attempt++

        $params = @{
            Uri         = $url
            Method      = $Method
            Headers     = $headers
            TimeoutSec  = $TimeoutSec
            ErrorAction = 'Stop'
        }
        if ($null -ne $Body) {
            $json = $Body | ConvertTo-Json -Depth 8 -Compress
            $params['Body'] = [System.Text.Encoding]::UTF8.GetBytes($json)
            $params['ContentType'] = 'application/json; charset=utf-8'
        }

        $previousProgress = $ProgressPreference
        $previousVerbose = $VerbosePreference
        try {
            $ProgressPreference = 'SilentlyContinue'
            # Invoke-RestMethod emits "VERBOSE: POST <uri>", and $VerbosePreference is
            # inherited from the caller -- so an orchestrator run with -Verbose would print
            # the deploy hook URL, secret key and all, to the console and any transcript.
            # Scoped to this call; the caller's own preference is restored in finally.
            $VerbosePreference = 'SilentlyContinue'
            return (Invoke-RestMethod @params)
        }
        catch {
            $status = Get-VercelStatusCode -ErrorRecord $_
            $bodyText = Protect-Secret -Text (Get-VercelErrorBody -ErrorRecord $_) -Secrets $scrub

            $retryable = $false
            # Status 0 (no response) and 5xx are the two "we did not see a result, but the
            # request may well have been delivered and acted on" cases -- a 502 from a
            # gateway says nothing about whether the origin already did the work. For a
            # non-idempotent call (the deploy hook) retrying either one fires an extra
            # production build, so -NonIdempotent suppresses BOTH and lets the caller see
            # the ambiguity instead of silently doubling up.
            if ($status -eq 0) { $retryable = -not $NonIdempotent }
            elseif ($status -ge 500 -and $status -le 599) { $retryable = -not $NonIdempotent }
            elseif ($status -eq 429 -and -not $NoRetryOn429) { $retryable = $true }

            if ($retryable -and $attempt -lt $script:MaxAttempts) {
                $delay = [int] [Math]::Pow(2, $attempt)   # 2, 4, 8
                $retryAfter = Get-VercelRetryAfterSeconds -ErrorRecord $_
                if ($retryAfter -gt $delay) { $delay = $retryAfter }
                Write-RotationLog -Level 'WARN' -Message (
                    'Vercel {0}: HTTP {1} (transient). Retry {2} of {3} in {4}s.' -f `
                        $Description, $status, $attempt, ($script:MaxAttempts - 1), $delay)
                Start-Sleep -Seconds $delay
                continue
            }

            $message = 'Vercel {0} failed with HTTP {1}.' -f $Description, $status
            if ($status -eq 0) {
                $message = 'Vercel {0} failed: no HTTP response (network, DNS or TLS).' -f $Description
            }
            if ($NonIdempotent -and ($status -eq 0 -or ($status -ge 500 -and $status -le 599))) {
                $message = $message + ' The request may or may not have taken effect, so it was NOT retried -- check the Vercel dashboard for a new deployment before running this again, because triggering the hook twice starts two production builds.'
            }
            if (-not [string]::IsNullOrWhiteSpace($bodyText)) {
                $message = $message + ' Vercel said: ' + $bodyText
            }

            # Thrown as an ErrorRecord carrying the status and the (already scrubbed) body
            # on TargetObject, so a caller can branch on WHICH failure this was -- e.g.
            # "already exists" -- instead of pattern-matching the message text.
            $errorInfo = [pscustomobject]@{
                Status      = $status
                Body        = $bodyText
                Description = $Description
            }
            $apiException = New-Object System.Exception($message)
            throw (New-Object System.Management.Automation.ErrorRecord(
                    $apiException,
                    'VercelApiError',
                    [System.Management.Automation.ErrorCategory]::InvalidOperation,
                    $errorInfo))
        }
        finally {
            $ProgressPreference = $previousProgress
            $VerbosePreference = $previousVerbose
        }
    }
}

function Get-VercelEnvList {
    <#
    .SYNOPSIS
      Normalise GET /v10/projects/{id}/env into a flat array.
    .NOTES
      The documented 200 body is a oneOf: a bare env object, { envs, pagination }, or
      { envs, hiddenProductionEnvCount }. Handle all three rather than assuming one.

      Every return is comma-wrapped so PowerShell cannot unwrap a one-element result into
      a bare object -- under Set-StrictMode 2.0 a caller doing .Count on that scalar
      throws, and "exactly one env var" is the common case here, not an edge case.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $false)] $Response)

    if ($null -eq $Response) { return , @() }

    $envs = Get-JsonProp -Object $Response -Name 'envs'
    if ($null -ne $envs) { return , @($envs) }
    if ($Response -is [System.Array]) { return , @($Response) }
    if ($null -ne (Get-JsonProp -Object $Response -Name 'key')) { return , @($Response) }
    return , @()
}

function Test-EnvTargetMatch {
    <#
    .SYNOPSIS
      Does this env record apply to the given target?
    .NOTES
      Vercel returns `target` as EITHER an array or a bare string, per the documented
      oneOf. Assuming an array silently matches nothing on the string form.
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter(Mandatory = $false)] $EnvRecord,
        [Parameter(Mandatory = $true)] [string] $Target
    )

    $value = Get-JsonProp -Object $EnvRecord -Name 'target'
    if ($null -eq $value) { return $false }
    if ($value -is [string]) { return ([string] $value -eq $Target) }
    foreach ($item in @($value)) {
        if ([string] $item -eq $Target) { return $true }
    }
    return $false
}

function Find-VercelEnvRecord {
    <#
    .SYNOPSIS
      The one env var matching both Name and Target, or $null. Throws if genuinely ambiguous.
    .NOTES
      Shared by the initial lookup and the create-collision recovery path, so both resolve
      "which variable is the secret" by identical rules. Two matchers would drift.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)] [string] $PlainToken,
        [Parameter(Mandatory = $true)] [string] $ProjectSegment,
        [Parameter(Mandatory = $false)] [hashtable] $Query = $null,
        [Parameter(Mandatory = $true)] [string] $Name,
        [Parameter(Mandatory = $true)] [string] $Target,
        [Parameter(Mandatory = $false)] [string[]] $Scrub = @()
    )

    $listResponse = Invoke-VercelApi -Method 'GET' `
        -Description ("list env vars for project (target {0})" -f $Target) `
        -Path ('/v10/projects/{0}/env' -f $ProjectSegment) `
        -Query $Query -PlainToken $PlainToken -ScrubValues $Scrub

    $found = @()
    foreach ($record in (Get-VercelEnvList -Response $listResponse)) {
        if ([string] (Get-JsonProp -Object $record -Name 'key' -Default '') -ne $Name) { continue }
        if (-not (Test-EnvTargetMatch -EnvRecord $record -Target $Target)) { continue }
        $found += $record
    }

    if ($found.Count -eq 0) { return $null }
    if ($found.Count -eq 1) { return $found[0] }

    # Branch-scoped preview variables can legitimately collide on (key, target).
    # Prefer the unscoped one; refuse to guess if that is still ambiguous.
    $unscoped = @()
    foreach ($record in $found) {
        if ([string]::IsNullOrWhiteSpace([string] (Get-JsonProp -Object $record -Name 'gitBranch' -Default ''))) {
            $unscoped += $record
        }
    }
    if ($unscoped.Count -eq 1) { return $unscoped[0] }

    throw ("Vercel has {0} environment variables named '{1}' on target '{2}'. Refusing to guess which one holds the secret -- remove the duplicates in the Vercel dashboard." -f $found.Count, $Name, $Target)
}

function Update-VercelEnvRecord {
    <#
    .SYNOPSIS
      PATCH an existing env var's value. Returns its id.
    .NOTES
      Sends only `value`, so the variable's other targets, comment and gitBranch survive
      untouched -- narrowing `target` here would silently drop it from the environments
      this rotation is not addressing. The one exception is an upgrade from plain to
      encrypted, because this function only ever writes secrets.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory = $true)] $Existing,
        [Parameter(Mandatory = $true)] [string] $PlainToken,
        [Parameter(Mandatory = $true)] [string] $ProjectSegment,
        [Parameter(Mandatory = $false)] [hashtable] $Query = $null,
        [Parameter(Mandatory = $true)] [string] $Name,
        [Parameter(Mandatory = $true)] [string] $Value,
        [Parameter(Mandatory = $false)] [string[]] $Scrub = @()
    )

    $envId = [string] (Get-JsonProp -Object $Existing -Name 'id' -Default '')
    if ([string]::IsNullOrWhiteSpace($envId)) {
        throw ("Vercel returned an environment variable named '{0}' with no id; cannot update it." -f $Name)
    }

    $body = @{ 'value' = $Value }
    if ([string] (Get-JsonProp -Object $Existing -Name 'type' -Default '') -eq 'plain') {
        $body['type'] = 'encrypted'
        Write-RotationLog -Level 'WARN' -Message ("Vercel: env var '{0}' was stored as plain text; upgrading it to encrypted." -f $Name)
    }

    $null = Invoke-VercelApi -Method 'PATCH' `
        -Description ("update env var '{0}'" -f $Name) `
        -Path ('/v9/projects/{0}/env/{1}' -f $ProjectSegment, [uri]::EscapeDataString($envId)) `
        -Query $Query -PlainToken $PlainToken -Body $body -ScrubValues $Scrub

    return $envId
}

function Get-DeployHookKey {
    <#
    .SYNOPSIS
      The deploy hook's key -- the last path segment of the hook URL.
    .DESCRIPTION
      A hook URL is /v1/integrations/deploy/{projectId}/{key}, and Vercel stamps the
      resulting deployment with that key as meta.deployHookId. Extracting it is what lets
      Wait-VercelDeployment identify OUR build exactly instead of guessing by timestamp.
    .NOTES
      The return value is a SECRET (anyone holding it can trigger a production deploy).
      Callers must add it to their scrub list and must never log it.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory = $false)] [string] $Url)

    if ([string]::IsNullOrWhiteSpace($Url)) { return '' }
    try {
        $parsed = [uri] $Url
        $segments = @($parsed.AbsolutePath -split '/' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        if ($segments.Count -eq 0) { return '' }
        return [string] $segments[$segments.Count - 1]
    }
    catch {
        return ''
    }
}

function ConvertTo-EpochMilliseconds {
    <#
    .SYNOPSIS
      A DateTime as a JavaScript (millisecond) timestamp, which is what Vercel's
      since/until/created fields use.
    #>
    [CmdletBinding()]
    [OutputType([long])]
    param([Parameter(Mandatory = $true)] [datetime] $Value)

    $epoch = [datetime]::SpecifyKind([datetime]'1970-01-01T00:00:00', [System.DateTimeKind]::Utc)
    return [long] (($Value.ToUniversalTime() - $epoch).TotalMilliseconds)
}

function Get-DeploymentReadyState {
    <#
    .SYNOPSIS
      Raw Vercel lifecycle state off a deployment record, preferring readyState.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory = $false)] $Deployment)

    foreach ($name in @('readyState', 'state', 'status')) {
        $value = Get-JsonProp -Object $Deployment -Name $name
        if (-not [string]::IsNullOrWhiteSpace([string] $value)) { return ([string] $value).ToUpperInvariant() }
    }
    return 'UNKNOWN'
}

function ConvertTo-WaitState {
    <#
    .SYNOPSIS
      Collapse Vercel's eight lifecycle states onto the three terminal states this module
      reports, or $null while the build is still in flight.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)] [string] $RawState)

    switch ($RawState) {
        'READY'    { return 'READY' }
        'ERROR'    { return 'ERROR' }
        'BLOCKED'  { return 'ERROR' }
        'CANCELED' { return 'CANCELED' }
        'DELETED'  { return 'CANCELED' }
        default    { return $null }   # QUEUED, INITIALIZING, BUILDING, UNKNOWN
    }
}


# ---------------------------------------------------------------------------
# Public surface
# ---------------------------------------------------------------------------

function Set-VercelEnvVar {
    <#
    .SYNOPSIS
      Upsert one project environment variable on Vercel for a single target.

    .DESCRIPTION
      Lists the project's environment variables, looks for one matching BOTH -Name and
      -Target, then PATCHes it if found or POSTs a new one if not.

        GET   /v10/projects/{idOrName}/env
        PATCH /v9/projects/{idOrName}/env/{id}
        POST  /v10/projects/{idOrName}/env

      Vercel bakes environment variables into a deployment at build time, so writing the
      variable changes nothing that is currently serving traffic. Follow this with
      Invoke-VercelDeployHook.

      The update sends only `value`, so an existing variable keeps whatever targets and
      comment it already had -- narrowing `target` to just this one would silently drop
      the variable from the other environments. The one exception: a variable currently
      stored as `plain` is upgraded to `encrypted` in the same PATCH, because this
      function's whole purpose is writing a secret.

      `?upsert=true` is deliberately not used; see the comment on the create path. A POST
      that loses its race and comes back "already exists" is recovered by re-reading and
      PATCHing, and is reported as 'updated' -- Action always names what actually
      happened, never what was attempted.

    .PARAMETER Token
      Vercel access token as a SecureString. Decrypted only for the duration of the call.

    .PARAMETER TeamId
      Team id, or $null/empty for a personal account -- in which case the teamId query
      parameter is omitted entirely rather than sent empty.

    .PARAMETER Value
      The new value. NEVER logged, never echoed, and scrubbed out of any error body.

    .PARAMETER Target
      One of production / preview / development.

    .OUTPUTS
      [pscustomobject] @{ Action = 'created'|'updated'; EnvId = [string] }

    .EXAMPLE
      Set-VercelEnvVar -Token $cfg.VercelToken -ProjectId $cfg.VercelProjectId `
                       -TeamId $cfg.VercelTeamId -Name 'GMAIL_REFRESH_TOKEN' `
                       -Value $newToken -Target 'production'
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory = $true)] [System.Security.SecureString] $Token,
        [Parameter(Mandatory = $true)] [ValidateNotNullOrEmpty()] [string] $ProjectId,
        [Parameter(Mandatory = $false)] [AllowNull()] [AllowEmptyString()] [string] $TeamId,
        [Parameter(Mandatory = $true)] [ValidateNotNullOrEmpty()] [string] $Name,
        [Parameter(Mandatory = $true)] [ValidateNotNullOrEmpty()] [string] $Value,
        [Parameter(Mandatory = $false)] [ValidateSet('production', 'preview', 'development')] [string] $Target = 'production'
    )

    $plainToken = $null
    try {
        $plainToken = ConvertFrom-SecureStringPlain -Secure $Token
        $projectSegment = [uri]::EscapeDataString($ProjectId)
        $query = @{ 'teamId' = $TeamId }
        $scrub = @($Value)

        Write-RotationLog -Level 'INFO' -Message ("Vercel: resolving env var '{0}' (target {1})." -f $Name, $Target)

        $existing = Find-VercelEnvRecord -PlainToken $plainToken -ProjectSegment $projectSegment `
            -Query $query -Name $Name -Target $Target -Scrub $scrub

        if ($null -ne $existing) {
            $envId = Update-VercelEnvRecord -Existing $existing -PlainToken $plainToken `
                -ProjectSegment $projectSegment -Query $query -Name $Name -Value $Value -Scrub $scrub
            Write-RotationLog -Level 'INFO' -Message ("Vercel: updated env var '{0}' on target '{1}'." -f $Name, $Target)
            return [pscustomobject]@{ Action = 'updated'; EnvId = $envId }
        }

        $createBody = @{
            'key'    = $Name
            'value'  = $Value
            'type'   = 'encrypted'
            'target' = @($Target)
        }

        # Deliberately NOT using ?upsert=true. The docs say only "a new environment variable
        # will not be created if it already exists but, the existing variable's value will
        # be updated" -- they never state whether "already exists" is keyed on `key` alone
        # or on (key, target), nor whether the upsert REWRITES the stored `target` array
        # with the one we send. If it keys on `key` and rewrites `target`, a create here
        # would silently strip this variable from preview/development, destroying exactly
        # the invariant Update-VercelEnvRecord exists to protect. Undocumented plus
        # destructive-if-wrong means we take the explicit route instead, below.
        try {
            $createResponse = Invoke-VercelApi -Method 'POST' `
                -Description ("create env var '{0}'" -f $Name) `
                -Path ('/v10/projects/{0}/env' -f $projectSegment) `
                -Query $query -PlainToken $plainToken -Body $createBody -ScrubValues $scrub
        }
        catch {
            # "Already exists" is reachable two ways: someone created it between our list
            # and our POST, or our own 5xx retry succeeded twice. Either way the variable
            # is there now -- re-read and PATCH it, and report 'updated', because that is
            # what actually happened. Reporting 'created' for an update would be a lie the
            # operator reads on the console.
            $info = $_.TargetObject
            $status = 0
            $reason = ''
            if ($null -ne $info) {
                $status = [int] (Get-JsonProp -Object $info -Name 'Status' -Default 0)
                $reason = [string] (Get-JsonProp -Object $info -Name 'Body' -Default '')
            }
            $alreadyExists = ($reason -match '(?i)already\s+exists') -and (@(400, 403, 409) -contains $status)
            if (-not $alreadyExists) { throw }

            Write-RotationLog -Level 'WARN' -Message ("Vercel: env var '{0}' already existed on create (HTTP {1}); re-reading and updating it instead." -f $Name, $status)

            $existing = Find-VercelEnvRecord -PlainToken $plainToken -ProjectSegment $projectSegment `
                -Query $query -Name $Name -Target $Target -Scrub $scrub
            if ($null -eq $existing) {
                throw ("Vercel rejected creating env var '{0}' on target '{1}' because it already exists, but it is not in the project's variable list. Resolve this in the Vercel dashboard." -f $Name, $Target)
            }

            $envId = Update-VercelEnvRecord -Existing $existing -PlainToken $plainToken `
                -ProjectSegment $projectSegment -Query $query -Name $Name -Value $Value -Scrub $scrub
            Write-RotationLog -Level 'INFO' -Message ("Vercel: updated env var '{0}' on target '{1}'." -f $Name, $Target)
            return [pscustomobject]@{ Action = 'updated'; EnvId = $envId }
        }

        # A 201 can still carry per-variable failures in `failed`; that is not an HTTP error.
        $failed = Get-JsonProp -Object $createResponse -Name 'failed'
        if ($null -ne $failed -and @($failed).Count -gt 0) {
            $first = @($failed)[0]
            $detail = Get-JsonProp -Object $first -Name 'error'
            $reason = [string] (Get-JsonProp -Object $detail -Name 'message' -Default 'no reason given')
            throw ("Vercel refused to create env var '{0}': {1}" -f $Name, (Protect-Secret -Text $reason -Secrets $scrub))
        }

        $created = Get-JsonProp -Object $createResponse -Name 'created'
        $newId = ''
        if ($null -ne $created) {
            $record = $created
            if ($created -is [System.Array]) {
                if (@($created).Count -gt 0) { $record = @($created)[0] } else { $record = $null }
            }
            $newId = [string] (Get-JsonProp -Object $record -Name 'id' -Default '')
        }

        Write-RotationLog -Level 'INFO' -Message ("Vercel: created env var '{0}' on target '{1}' (encrypted)." -f $Name, $Target)
        return [pscustomobject]@{ Action = 'created'; EnvId = $newId }
    }
    finally {
        if ($null -ne $plainToken) { $plainToken = $null }
    }
}


function Invoke-VercelDeployHook {
    <#
    .SYNOPSIS
      Fire a Vercel deploy hook to start a new production build.

    .DESCRIPTION
      POSTs to the hook URL (https://api.vercel.com/v1/integrations/deploy/{projectId}/{key}).
      The hook needs no Authorization header -- the secret is the URL, which is exactly why
      it is held as a SecureString and never logged, not even on an error path.

      Vercel answers with { "job": { "id", "state", "createdAt" } }. That job id is NOT a
      deployment id and cannot be looked up; use the returned RequestedAt with
      Wait-VercelDeployment instead.

      NOTHING is retried here, and that is enforced by two switches rather than assumed --
      firing a deploy hook is not idempotent, so every retry is another full production
      deploy of main against a budget of 60 triggers per hour. The complete matrix for
      this call:

        429      not retried (-NoRetryOn429). Triggers are capped at 60/hour per project;
                 seconds of backoff cannot clear an hourly budget.
        5xx      not retried (-NonIdempotent). A gateway error says nothing about whether
                 the origin already queued the build.
        status 0 not retried (-NonIdempotent). The response was lost; the request may
                 still have been delivered.
        4xx      not retried (never was). A bad hook URL does not heal by waiting.

      So one call to this function triggers at most one build. The 5xx and status-0 cases
      are the ambiguous ones, and both throw a message saying plainly that the hook may or
      may not have fired and the dashboard should be checked before re-running; the caller
      records the rotation as failed and a human decides.

    .PARAMETER HookUrl
      The full deploy hook URL as a SecureString.

    .OUTPUTS
      [pscustomobject] @{ JobId = [string]; RequestedAt = [datetime] }
      RequestedAt is Vercel's own job.createdAt where present -- using the server's clock
      removes local clock skew from the Wait-VercelDeployment window. It falls back to the
      moment just BEFORE the POST, never after, so the window cannot open past the
      deployment it is meant to find.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory = $true)] [System.Security.SecureString] $HookUrl
    )

    $plainUrl = $null
    try {
        $plainUrl = ConvertFrom-SecureStringPlain -Secure $HookUrl
        if ([string]::IsNullOrWhiteSpace($plainUrl)) {
            throw 'The configured deploy hook URL is empty. Re-run setup.ps1.'
        }
        if ($plainUrl -notmatch '^https://') {
            throw 'The configured deploy hook URL is not an https:// URL.'
        }

        $requestedAt = (Get-Date)
        Write-RotationLog -Level 'INFO' -Message 'Vercel: triggering deploy hook.'

        $response = Invoke-VercelApi -Method 'POST' `
            -Description 'trigger deploy hook' `
            -AbsoluteUrl $plainUrl -NoRetryOn429 -NonIdempotent

        $job = Get-JsonProp -Object $response -Name 'job'
        $jobId = [string] (Get-JsonProp -Object $job -Name 'id' -Default '')

        $createdAt = Get-JsonProp -Object $job -Name 'createdAt'
        if ($null -ne $createdAt) {
            try {
                $epoch = [datetime]::SpecifyKind([datetime]'1970-01-01T00:00:00', [System.DateTimeKind]::Utc)
                $serverTime = $epoch.AddMilliseconds([double] $createdAt).ToLocalTime()
                # Only trust it if it is sane; a wildly wrong stamp is worse than our own.
                if ([Math]::Abs(($serverTime - $requestedAt).TotalHours) -lt 24) {
                    $requestedAt = $serverTime
                }
            }
            catch { }
        }

        Write-RotationLog -Level 'INFO' -Message ("Vercel: deploy hook accepted (job {0})." -f $jobId)
        return [pscustomobject]@{ JobId = $jobId; RequestedAt = $requestedAt }
    }
    finally {
        if ($null -ne $plainUrl) { $plainUrl = $null }
    }
}


function Wait-VercelDeployment {
    <#
    .SYNOPSIS
      Wait for the deployment triggered at -Since to reach a terminal state.

    .DESCRIPTION
      Polls GET /v7/deployments?projectId=...&target=production&since=... roughly every
      10 seconds to identify the deployment, then polls GET /v13/deployments/{id} for that
      one deployment until it settles. Only STATE TRANSITIONS are logged, not every poll.

      Identifying the right deployment matters more than it looks. The hook returns a job
      id that is not a deployment id and cannot be looked up, so the deployment has to be
      recognised. Getting it wrong is silent and dangerous: locking onto a build that
      started BEFORE the environment variable was written means that build baked the OLD
      token, yet it goes READY and the rotation is recorded as a success -- and mail dies
      days later with no signal. So:

        Candidates = projectId + target=production, within a window whose width depends on
        how confidently we can identify the build -- wide (Since - 60s) when an exact
        hook-id match is possible, tight (exactly Since) whenever we are guessing. The
        asymmetry is deliberate and is explained at the point it is applied.

        1. EXACT MATCH (preferred). A hook URL ends /v1/integrations/deploy/{projectId}/{key},
           and Vercel stamps the resulting deployment with that key as meta.deployHookId.
           Pass -HookUrl and the deployment whose meta.deployHookId equals that key wins
           outright -- our build, positively identified, not inferred.
        2. HEURISTIC FALLBACK. meta.deployHookId is real but undocumented, so it may
           vanish; and -HookUrl is optional. Failing an exact match, the OLDEST candidate
           at or after Since wins (the hook fired at Since, so the first build after it is
           ours; a later one is someone else's push racing us) and a WARN is logged saying
           the match was a guess. The ambiguity is always visible in the log, never silent.

      Once a deployment id is locked in, polling stays on that id and never re-selects, so
      an unrelated deployment starting mid-wait cannot hijack the result.

    .PARAMETER Since
      The RequestedAt returned by Invoke-VercelDeployHook.

    .PARAMETER HookUrl
      Optional. The same deploy hook URL passed to Invoke-VercelDeployHook, as a
      SecureString. Only its last path segment is used, in memory, to match
      meta.deployHookId; it is added to the scrub list so it cannot reach a log line or a
      thrown message. Omit it and identification falls back to the timestamp heuristic.

    .PARAMETER TimeoutMinutes
      Defaults to 10.

    .OUTPUTS
      [pscustomobject] @{ State = 'READY'|'ERROR'|'CANCELED'|'TIMEOUT'; Url = [string];
                          DeploymentId = [string]; WaitedSeconds = [int] }
      TIMEOUT is a RETURNED state, never a throw: a build that is merely slow is not a
      failed rotation. The new secret is already written and the build will still finish;
      the caller decides whether to warn or ignore.
      Url is 'https://' + the deployment hostname, or '' if none was identified.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory = $true)] [System.Security.SecureString] $Token,
        [Parameter(Mandatory = $true)] [ValidateNotNullOrEmpty()] [string] $ProjectId,
        [Parameter(Mandatory = $false)] [AllowNull()] [AllowEmptyString()] [string] $TeamId,
        [Parameter(Mandatory = $true)] [datetime] $Since,
        [Parameter(Mandatory = $false)] [AllowNull()] [System.Security.SecureString] $HookUrl = $null,
        [Parameter(Mandatory = $false)] [ValidateRange(1, 120)] [int] $TimeoutMinutes = 10
    )

    $plainToken = $null
    $hookKey = ''
    $startedAt = (Get-Date)
    $deadline = $startedAt.AddMinutes($TimeoutMinutes)

    $deploymentId = ''
    $deploymentUrl = ''
    $lastState = ''

    try {
        $plainToken = ConvertFrom-SecureStringPlain -Secure $Token

        # The hook key is a secret. Extract it, keep it in memory only, and put it on the
        # scrub list for every call below so it can never reach a log or a thrown message.
        if ($null -ne $HookUrl) {
            $plainHookUrl = $null
            try {
                $plainHookUrl = ConvertFrom-SecureStringPlain -Secure $HookUrl
                $hookKey = Get-DeployHookKey -Url $plainHookUrl
            }
            finally {
                $plainHookUrl = $null
            }
        }
        $scrub = @()
        if (-not [string]::IsNullOrWhiteSpace($hookKey)) { $scrub += $hookKey }

        # THE WINDOW IS DELIBERATELY ASYMMETRIC, and the asymmetry is the whole design:
        #
        #   Wide (Since - 60s) when we hold a hook key, because identification is then by
        #   exact meta.deployHookId. A teammate's build cannot carry OUR hook id no matter
        #   how wide the window is, so width costs nothing and buys tolerance for
        #   `deployment.created` being stamped slightly before `job.createdAt` -- different
        #   Vercel services, different clocks. Too tight and our own build never enters the
        #   candidate set, producing a TIMEOUT with no id on a rotation that deployed fine:
        #   a false alarm on the success path, which teaches the operator to ignore alarms.
        #
        #   Tight (exactly Since) whenever we are GUESSING, because width is precisely what
        #   makes the guess dangerous -- it admits builds that started before the env var
        #   was written and therefore baked the OLD token.
        #
        # Note the heuristic set stays tight even when a hook key IS present, since an
        # exact match may still fail (meta.deployHookId is undocumented and could vanish).
        $exactWindowMs = ConvertTo-EpochMilliseconds -Value $Since
        if (-not [string]::IsNullOrWhiteSpace($hookKey)) {
            $exactWindowMs = ConvertTo-EpochMilliseconds -Value $Since.AddSeconds(-1 * $script:HookMatchBackdateSeconds)
        }
        $heuristicWindowMs = ConvertTo-EpochMilliseconds -Value $Since

        $warnedHeuristic = $false
        $warnedMissingId = $false
        $sawUntrackable = $false

        Write-RotationLog -Level 'INFO' -Message ('Vercel: waiting up to {0} min for the new production deployment.' -f $TimeoutMinutes)
        if ([string]::IsNullOrWhiteSpace($hookKey)) {
            Write-RotationLog -Level 'WARN' -Message 'Vercel: no deploy hook URL supplied, so the deployment cannot be matched exactly; falling back to timestamp matching.'
        }

        while ((Get-Date) -lt $deadline) {

            if ([string]::IsNullOrWhiteSpace($deploymentId)) {
                $listResponse = Invoke-VercelApi -Method 'GET' `
                    -Description 'list deployments' `
                    -Path '/v7/deployments' `
                    -Query @{
                        'projectId' = $ProjectId
                        'teamId'    = $TeamId
                        'target'    = 'production'
                        'since'     = [string] $exactWindowMs
                        'limit'     = '20'
                    } `
                    -PlainToken $plainToken -ScrubValues $scrub

                # Two candidate sets from one response: the wide set only ever feeds exact
                # hook-id matching, the tight set only ever feeds the timestamp guess.
                $exactCandidates = @()
                $heuristicCandidates = @()
                foreach ($record in @(Get-JsonProp -Object $listResponse -Name 'deployments' -Default @())) {
                    $created = Get-JsonProp -Object $record -Name 'created'
                    if ($null -eq $created) { $created = Get-JsonProp -Object $record -Name 'createdAt' }
                    if ($null -eq $created) { continue }
                    if ([long] $created -ge $exactWindowMs) { $exactCandidates += $record }
                    if ([long] $created -ge $heuristicWindowMs) { $heuristicCandidates += $record }
                }

                # 1. Exact: the deployment Vercel stamped with OUR hook key.
                $chosen = $null
                $matchedExactly = $false
                if (-not [string]::IsNullOrWhiteSpace($hookKey)) {
                    foreach ($record in $exactCandidates) {
                        $meta = Get-JsonProp -Object $record -Name 'meta'
                        $stamped = [string] (Get-JsonProp -Object $meta -Name 'deployHookId' -Default '')
                        if ($stamped -eq $hookKey) { $chosen = $record; $matchedExactly = $true; break }
                    }
                }

                # 2. Fallback: oldest at or after Since, compared explicitly rather than
                #    trusting /v7/deployments' (undocumented) newest-first ordering.
                if ($null -eq $chosen -and $heuristicCandidates.Count -gt 0) {
                    $oldest = $null
                    $oldestCreated = [long]::MaxValue
                    foreach ($record in $heuristicCandidates) {
                        $created = Get-JsonProp -Object $record -Name 'created'
                        if ($null -eq $created) { $created = Get-JsonProp -Object $record -Name 'createdAt' }
                        if ($null -eq $created) { continue }
                        if ([long] $created -lt $oldestCreated) {
                            $oldestCreated = [long] $created
                            $oldest = $record
                        }
                    }
                    if ($null -ne $oldest) {
                        $chosen = $oldest
                        if (-not $warnedHeuristic) {
                            $warnedHeuristic = $true
                            Write-RotationLog -Level 'WARN' -Message (
                                'Vercel: no deployment carried our deploy hook id, so the build was matched by timestamp instead ({0} candidate(s) at or after the trigger). If a teammate deployed at the same moment, the tracked build may not be ours -- confirm the deployed token if mail fails.' -f $heuristicCandidates.Count)
                        }
                    }
                }

                if ($null -ne $chosen) {
                    $chosenId = [string] (Get-JsonProp -Object $chosen -Name 'uid' -Default '')
                    if ([string]::IsNullOrWhiteSpace($chosenId)) {
                        $chosenId = [string] (Get-JsonProp -Object $chosen -Name 'id' -Default '')
                    }

                    if ([string]::IsNullOrWhiteSpace($chosenId)) {
                        # A matched record with neither uid nor id cannot be tracked, and
                        # must NOT fall through to the empty-string sentinel: '' means
                        # "nothing was ever found", which the orchestrator alarms on.
                        # Record that we DID see a build, warn once rather than every poll,
                        # and keep polling in case the next listing carries the id.
                        $sawUntrackable = $true
                        if (-not $warnedMissingId) {
                            $warnedMissingId = $true
                            Write-RotationLog -Level 'WARN' -Message 'Vercel: a matching deployment was found but Vercel returned no id for it, so it cannot be tracked. Still polling in case a later listing includes one.'
                        }
                        Start-Sleep -Seconds $script:PollIntervalSec
                        continue
                    }

                    $deploymentId = $chosenId
                    # Not $host -- that is PowerShell's read-only automatic variable.
                    $hostName = [string] (Get-JsonProp -Object $chosen -Name 'url' -Default '')
                    if (-not [string]::IsNullOrWhiteSpace($hostName)) { $deploymentUrl = 'https://' + $hostName }
                    if ($matchedExactly) {
                        Write-RotationLog -Level 'INFO' -Message ('Vercel: tracking deployment {0} (matched our deploy hook id).' -f $deploymentId)
                    }
                    else {
                        Write-RotationLog -Level 'INFO' -Message ('Vercel: tracking deployment {0}.' -f $deploymentId)
                    }

                    $rawState = Get-DeploymentReadyState -Deployment $chosen
                    if ($rawState -ne $lastState) {
                        $lastState = $rawState
                        Write-RotationLog -Level 'INFO' -Message ('Vercel: deployment {0} is {1}.' -f $deploymentId, $rawState)
                    }
                    $settled = ConvertTo-WaitState -RawState $rawState
                    if ($null -ne $settled) {
                        return [pscustomobject]@{
                            State         = $settled
                            Url           = $deploymentUrl
                            DeploymentId  = $deploymentId
                            WaitedSeconds = [int] ((Get-Date) - $startedAt).TotalSeconds
                        }
                    }
                }
            }
            else {
                $detail = Invoke-VercelApi -Method 'GET' `
                    -Description 'get deployment' `
                    -Path ('/v13/deployments/{0}' -f [uri]::EscapeDataString($deploymentId)) `
                    -Query @{ 'teamId' = $TeamId } `
                    -PlainToken $plainToken -ScrubValues $scrub

                $hostName = [string] (Get-JsonProp -Object $detail -Name 'url' -Default '')
                if (-not [string]::IsNullOrWhiteSpace($hostName)) { $deploymentUrl = 'https://' + $hostName }

                $rawState = Get-DeploymentReadyState -Deployment $detail
                if ($rawState -ne $lastState) {
                    $lastState = $rawState
                    Write-RotationLog -Level 'INFO' -Message ('Vercel: deployment {0} is {1}.' -f $deploymentId, $rawState)
                }

                $settled = ConvertTo-WaitState -RawState $rawState
                if ($null -ne $settled) {
                    if ($settled -ne 'READY') {
                        $reason = [string] (Get-JsonProp -Object $detail -Name 'errorMessage' -Default '')
                        if (-not [string]::IsNullOrWhiteSpace($reason)) {
                            Write-RotationLog -Level 'ERROR' -Message ('Vercel: deployment {0} ended {1}: {2}' -f `
                                $deploymentId, $settled, (Protect-Secret -Text $reason -Secrets $scrub))
                        }
                    }
                    return [pscustomobject]@{
                        State         = $settled
                        Url           = $deploymentUrl
                        DeploymentId  = $deploymentId
                        WaitedSeconds = [int] ((Get-Date) - $startedAt).TotalSeconds
                    }
                }
            }

            Start-Sleep -Seconds $script:PollIntervalSec
        }

        if ([string]::IsNullOrWhiteSpace($deploymentId)) {
            if ($sawUntrackable) {
                # Distinct from "nothing appeared": a build WAS found, we just never got an
                # id for it. Same '' return per the contract, but the log must not claim
                # no deployment started -- that would send the operator hunting a non-bug.
                Write-RotationLog -Level 'WARN' -Message ('Vercel: a matching deployment was found within {0} min but Vercel never returned an id for it, so its outcome is unknown. The build itself is unaffected -- check the Vercel dashboard.' -f $TimeoutMinutes)
            }
            else {
                Write-RotationLog -Level 'WARN' -Message ('Vercel: no deployment appeared within {0} min of the deploy hook.' -f $TimeoutMinutes)
            }
        }
        else {
            Write-RotationLog -Level 'WARN' -Message ('Vercel: deployment {0} still {1} after {2} min; giving up waiting (the build continues).' -f `
                $deploymentId, $lastState, $TimeoutMinutes)
        }

        return [pscustomobject]@{
            State         = 'TIMEOUT'
            Url           = $deploymentUrl
            DeploymentId  = $deploymentId
            WaitedSeconds = [int] ((Get-Date) - $startedAt).TotalSeconds
        }
    }
    finally {
        if ($null -ne $plainToken) { $plainToken = $null }
        $hookKey = $null
    }
}


function Test-VercelAccess {
    <#
    .SYNOPSIS
      Read-only preflight: can this token see this project, and does the env var exist?

    .DESCRIPTION
      Two GETs and nothing else:
        GET /v9/projects/{idOrName}       -- proves the token can reach the project
        GET /v10/projects/{idOrName}/env  -- proves it can read env vars, and reports
                                             whether -EnvVarName is already there

      Mutates nothing, and does NOT throw on an auth failure -- a -Verify run exists to
      REPORT that the token is wrong, so a bad token comes back as Ok = $false with
      Vercel's own (scrubbed) explanation in Message. Only a caller-side bug (a malformed
      SecureString) can still throw.

      Note the env-var read requests no decryption, so no secret value is ever returned.

    .OUTPUTS
      [pscustomobject] @{ Ok = [bool]; ProjectName = [string]; EnvVarExists = [bool]; Message = [string] }
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory = $true)] [System.Security.SecureString] $Token,
        [Parameter(Mandatory = $true)] [ValidateNotNullOrEmpty()] [string] $ProjectId,
        [Parameter(Mandatory = $false)] [AllowNull()] [AllowEmptyString()] [string] $TeamId,
        [Parameter(Mandatory = $false)] [string] $EnvVarName = 'GMAIL_REFRESH_TOKEN'
    )

    $plainToken = $null
    $result = [pscustomobject]@{
        Ok           = $false
        ProjectName  = ''
        EnvVarExists = $false
        Message      = ''
    }

    try {
        $plainToken = ConvertFrom-SecureStringPlain -Secure $Token
        $projectSegment = [uri]::EscapeDataString($ProjectId)
        $query = @{ 'teamId' = $TeamId }

        $project = Invoke-VercelApi -Method 'GET' `
            -Description 'read project' `
            -Path ('/v9/projects/{0}' -f $projectSegment) `
            -Query $query -PlainToken $plainToken

        $result.ProjectName = [string] (Get-JsonProp -Object $project -Name 'name' -Default '')

        $listResponse = Invoke-VercelApi -Method 'GET' `
            -Description 'list env vars' `
            -Path ('/v10/projects/{0}/env' -f $projectSegment) `
            -Query $query -PlainToken $plainToken

        foreach ($record in (Get-VercelEnvList -Response $listResponse)) {
            if ([string] (Get-JsonProp -Object $record -Name 'key' -Default '') -eq $EnvVarName) {
                $result.EnvVarExists = $true
                break
            }
        }

        $result.Ok = $true
        if ($result.EnvVarExists) {
            $result.Message = "Vercel access OK. Project '$($result.ProjectName)' reachable and '$EnvVarName' exists."
        }
        else {
            $result.Message = "Vercel access OK. Project '$($result.ProjectName)' reachable, but '$EnvVarName' does not exist yet -- the first rotation will create it."
        }

        Write-RotationLog -Level 'INFO' -Message ('Vercel preflight: ' + $result.Message)
        return $result
    }
    catch {
        # Report, never throw: the whole point of -Verify is to surface this calmly.
        $result.Ok = $false
        $secrets = @()
        if (-not [string]::IsNullOrWhiteSpace($plainToken)) { $secrets += $plainToken }
        $result.Message = Protect-Secret -Text ([string] $_.Exception.Message) -Secrets $secrets
        if ([string]::IsNullOrWhiteSpace($result.Message)) { $result.Message = 'Vercel access check failed for an unknown reason.' }
        Write-RotationLog -Level 'ERROR' -Message ('Vercel preflight failed: ' + $result.Message)
        return $result
    }
    finally {
        if ($null -ne $plainToken) { $plainToken = $null }
    }
}


Export-ModuleMember -Function @(
    'Set-VercelEnvVar'
    'Invoke-VercelDeployHook'
    'Wait-VercelDeployment'
    'Test-VercelAccess'
)
