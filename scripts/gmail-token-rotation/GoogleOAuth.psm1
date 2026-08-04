<#
.SYNOPSIS
  Interactive Google OAuth 2.0 (authorization code + PKCE) flow for an installed
  ("Desktop app") client, used to mint a fresh Gmail API refresh token.

.DESCRIPTION
  The Cloud project's consent screen is deliberately in "Testing" status, so Google
  expires its refresh tokens after 7 days and the only way to replace one is to
  re-authorize. This module owns exactly that act and nothing else: it knows about
  Google, and about Common.psm1. It knows nothing about Vercel, the scheduler, or
  where the token ends up.

  TWO-ATTEMPT STRATEGY. Google's native-app documentation states that "refresh tokens
  are always returned for installed applications" and lists neither access_type nor
  prompt; the web-server documentation says access_type=offline is what produces one.
  If the native-app doc is right, an already-granted Desktop client can be
  re-authorized with no consent screen and no click at all. So:

    1. SILENT  - authorize with access_type=offline and prompt=none, which forbids
                 Google from rendering ANY user interface. It answers immediately:
                 a code if the grant is live and the browser session is valid, or
                 error=interaction_required / login_required / consent_required /
                 account_selection_required if a human is needed.
    2. CONSENT - if the silent attempt times out, is denied, or exchanges into a
                 response with no refresh_token (or without gmail.send), fall back to
                 prompt=consent on the full -TimeoutSeconds budget, which requires a
                 human. -ForceConsent skips step 1 entirely.

  Every attempt is independent: fresh PKCE pair, fresh state nonce, fresh ephemeral
  port and listener. Nothing is reused between them.

  Flow per https://developers.google.com/identity/protocols/oauth2/native-app:
  PKCE S256, loopback redirect on http://127.0.0.1:<port>, code exchanged at
  https://oauth2.googleapis.com/token.

  SECRET HYGIENE: the client secret, the authorization code, the access token and the
  refresh token are never written to the log, the console, the HTML page served to the
  browser, or an exception message. Failures log the HTTP status plus Google's own
  `error` / `error_description` fields and nothing else. The returned object carries
  the tokens as properties but its default display set deliberately omits them, so a
  caller who forgets to assign the result does not print a token to the terminal.

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

$script:AuthEndpoint   = 'https://accounts.google.com/o/oauth2/v2/auth'
$script:TokenEndpoint  = 'https://oauth2.googleapis.com/token'
$script:GmailSendScope = 'https://www.googleapis.com/auth/gmail.send'
$script:ResultTypeName = 'Dcsim.GmailRotation.OAuthToken'

# The errors prompt=none returns when it would have had to show something. These are
# ORDINARY outcomes of the silent attempt -- the expected answer whenever the 7-day
# grant has been retired or the browser session has lapsed -- so they are logged at
# INFO and fall through to the consent attempt. Logging them as errors would make
# every single rotation look like it failed at something.
$script:SilentRetryErrors = @(
    'interaction_required'
    'login_required'
    'consent_required'
    'account_selection_required'
)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

function ConvertTo-Base64Url {
    <#
    .SYNOPSIS
      RFC 4648 base64url with the '=' padding stripped, as PKCE requires.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory = $true)] [byte[]] $Bytes
    )

    $b64 = [Convert]::ToBase64String($Bytes)
    return $b64.TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function New-RandomUrlSafeString {
    <#
    .SYNOPSIS
      base64url of N cryptographically random bytes.
    .NOTES
      32 bytes -> 43 characters, which is exactly the minimum length Google specifies
      for a PKCE code_verifier (43..128 unreserved characters). base64url's alphabet
      is a subset of the unreserved set, so no further escaping is needed.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory = $false)] [int] $ByteCount = 32
    )

    $rng = $null
    try {
        $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        $bytes = New-Object 'byte[]' $ByteCount
        $rng.GetBytes($bytes)
        return (ConvertTo-Base64Url -Bytes $bytes)
    }
    finally {
        if ($null -ne $rng) { $rng.Dispose() }
    }
}

function Get-PkceChallenge {
    <#
    .SYNOPSIS
      S256 challenge: base64url( SHA256( ASCII(verifier) ) ).
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory = $true)] [string] $Verifier
    )

    $sha = $null
    try {
        $sha = [System.Security.Cryptography.SHA256]::Create()
        $hash = $sha.ComputeHash([System.Text.Encoding]::ASCII.GetBytes($Verifier))
        return (ConvertTo-Base64Url -Bytes $hash)
    }
    finally {
        if ($null -ne $sha) { $sha.Dispose() }
    }
}

function Get-FreeLoopbackPort {
    <#
    .SYNOPSIS
      Ask the OS for an unused TCP port by binding to port 0 and reading it back.
    .NOTES
      TOCTOU: between stopping this TcpListener and binding the HttpListener, another
      process could theoretically claim the port. The window is microseconds, the port
      is drawn from the ephemeral range, and the failure mode is a loud bind error
      rather than a silent misroute -- so it is accepted here rather than retried.
      There is no way to hand a live socket to HttpListener, so this is the standard
      approach for the loopback flow.
    #>
    [CmdletBinding()]
    [OutputType([int])]
    param()

    $probe = $null
    try {
        $probe = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Loopback), 0
        $probe.Start()
        return [int]$probe.LocalEndpoint.Port
    }
    finally {
        if ($null -ne $probe) {
            try { $probe.Stop() } catch { }
        }
    }
}

function New-QueryString {
    <#
    .SYNOPSIS
      Build an application/x-www-form-urlencoded string, escaping every value.
    .NOTES
      Ordered so the emitted URL is stable and reviewable. EscapeDataString is used
      rather than a hashtable body so the encoding is explicit and identical between
      the authorization URL and the token POST -- redirect_uri must match byte for byte.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory = $true)] [System.Collections.Specialized.OrderedDictionary] $Pairs
    )

    $parts = New-Object System.Collections.Generic.List[string]
    foreach ($key in $Pairs.Keys) {
        $name = [System.Uri]::EscapeDataString([string]$key)
        $value = [System.Uri]::EscapeDataString([string]$Pairs[$key])
        $parts.Add("$name=$value")
    }
    return ($parts -join '&')
}

function Get-GoogleErrorDetail {
    <#
    .SYNOPSIS
      Turn a failed Invoke-RestMethod into "HTTP <status>: <error> - <description>".
    .NOTES
      Handles BOTH exception shapes. Windows PowerShell 5.1 throws
      System.Net.WebException, whose body is only reachable through the response
      stream. pwsh 6+ throws Microsoft.PowerShell.Commands.HttpResponseException, whose
      .Response is an HttpResponseMessage with no GetResponseStream() -- there the body
      has already been buffered into $ErrorRecord.ErrorDetails.Message. Matching only
      WebException would degrade every pwsh 400 to "HTTP unknown" and lose exactly the
      invalid_grant / invalid_client detail the caller's error message promises.

      Only Google's `error` and `error_description` fields are surfaced. The raw
      response body is never returned, so a body that unexpectedly echoes a request
      value cannot leak into a log line or an exception message.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory = $true)] $ErrorRecord
    )

    $status = 'unknown'
    $code = ''
    $description = ''
    $body = $null

    $ex = $ErrorRecord.Exception

    # --- status: both exception shapes expose it, just not in the same place ---
    # Walk the chain rather than reading the top exception only. Invoke-RestMethod
    # itself does not wrap, but PowerShell wraps anything thrown by a raw .NET method
    # call in a MethodInvocationException, which would otherwise hide the status
    # behind "HTTP unknown" for any caller that retries through a helper.
    $response = $null
    $webEx = $null
    $probe = $ex
    $depth = 0
    while ($null -ne $probe -and $depth -lt 4) {
        $probeProps = @($probe.PSObject.Properties.Name)
        # pwsh's HttpResponseException carries the code directly on the exception.
        if ($status -eq 'unknown' -and $probeProps -contains 'StatusCode') {
            try { $status = [string][int]$probe.StatusCode } catch { $status = 'unknown' }
        }
        if ($null -eq $response -and $probeProps -contains 'Response' -and $null -ne $probe.Response) {
            $response = $probe.Response
            if ($probe -is [System.Net.WebException]) { $webEx = $probe }
        }
        if ($probeProps -contains 'InnerException') { $probe = $probe.InnerException } else { $probe = $null }
        $depth++
    }
    if ($status -eq 'unknown' -and $null -ne $response) {
        $respProps = @($response.PSObject.Properties.Name)
        if ($respProps -contains 'StatusCode') {
            try { $status = [string][int]$response.StatusCode } catch { $status = 'unknown' }
        }
    }

    # --- body: prefer the already-buffered copy, else drain the WebException stream ---
    if ($null -ne $ErrorRecord.ErrorDetails -and
        -not [string]::IsNullOrWhiteSpace($ErrorRecord.ErrorDetails.Message)) {
        $body = $ErrorRecord.ErrorDetails.Message
    }
    elseif ($null -ne $webEx -and $null -ne $response) {
        $reader = $null
        try {
            $stream = $response.GetResponseStream()
            if ($null -ne $stream) {
                $reader = New-Object System.IO.StreamReader($stream)
                $body = $reader.ReadToEnd()
            }
        }
        catch { }
        finally {
            if ($null -ne $reader) { try { $reader.Dispose() } catch { } }
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($body)) {
        $json = $null
        try { $json = $body | ConvertFrom-Json } catch { $json = $null }
        if ($null -ne $json) {
            $names = @($json.PSObject.Properties.Name)
            if ($names -contains 'error') { $code = [string]$json.error }
            if ($names -contains 'error_description') { $description = [string]$json.error_description }
        }
    }

    $detail = "HTTP $status"
    if (-not [string]::IsNullOrWhiteSpace($code)) { $detail = "$detail`: $code" }
    if (-not [string]::IsNullOrWhiteSpace($description)) { $detail = "$detail - $description" }
    return $detail
}

function Get-CallbackHtml {
    <#
    .SYNOPSIS
      The small page the browser lands on. Contains no secret of any kind.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory = $true)] [bool] $Success,
        [Parameter(Mandatory = $true)] [string] $Headline,
        [Parameter(Mandatory = $true)] [string] $Detail
    )

    if ($Success) { $accent = '#137a4b' } else { $accent = '#b3261e' }
    if ($Success) { $mark = '&#10003;' } else { $mark = '&#10007;' }

    # $Headline/$Detail are module-authored constants, never echoed request data,
    # so there is nothing here that needs HTML-escaping.
    return @"
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gmail token rotation</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         font:16px/1.55 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
         background:#fbfcf9; color:#1a1c19; }
  .card { max-width:34rem; padding:2.25rem 2.5rem; border:1px solid #dfe3da; border-radius:12px;
          background:#fff; box-shadow:0 1px 2px rgba(0,0,0,.06); text-align:center; }
  .mark { font-size:2.5rem; line-height:1; color:$accent; }
  h1 { font-size:1.25rem; margin:.75rem 0 .5rem; }
  p { margin:.5rem 0; color:#454940; }
  .close { margin-top:1.25rem; font-size:.875rem; color:#6b7065; }
  @media (prefers-color-scheme: dark) {
    body { background:#14161a; color:#e6e8e3; }
    .card { background:#1c1f24; border-color:#2c3038; }
    p { color:#b9beb4; } .close { color:#8b9186; }
  }
</style>
</head>
<body>
  <div class="card">
    <div class="mark">$mark</div>
    <h1>$Headline</h1>
    <p>$Detail</p>
    <p class="close">You can close this tab and return to the PowerShell window.</p>
  </div>
</body>
</html>
"@
}

function Write-CallbackResponse {
    <#
    .SYNOPSIS
      Write an HTML body to the HttpListener response and close it.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)] $Context,
        [Parameter(Mandatory = $true)] [int] $StatusCode,
        [Parameter(Mandatory = $true)] [string] $Html
    )

    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Html)
        $Context.Response.StatusCode = $StatusCode
        $Context.Response.ContentType = 'text/html; charset=utf-8'
        $Context.Response.ContentLength64 = $bytes.Length
        $Context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    }
    catch {
        # A browser that hung up mid-write must not fail the rotation; we already
        # have (or do not have) the code regardless of whether the page rendered.
        Write-RotationLog -Level 'WARN' -Message "Could not write the callback page: $($_.Exception.Message)"
    }
    finally {
        try { $Context.Response.OutputStream.Close() } catch { }
        try { $Context.Response.Close() } catch { }
    }
}


# ---------------------------------------------------------------------------
# One authorization attempt
# ---------------------------------------------------------------------------

function Get-GoogleAuthorizationCode {
    <#
    .SYNOPSIS
      Run ONE browser round trip and return an authorization code, or a failure reason.

    .DESCRIPTION
      Self-contained on purpose: every call mints its OWN PKCE verifier/challenge, its
      OWN state nonce and its OWN ephemeral port + listener. The silent attempt and the
      consent fallback must never share any of these -- reusing a nonce or a verifier
      across attempts would let a stale redirect from the first satisfy the second.

    .PARAMETER PromptMode
      'none' for the silent attempt (Google may render NO user interface at all) or
      'consent' for the interactive fallback. See the caller for why that matters.

    .PARAMETER ThrowOnFailure
      $true for the final attempt, where a failure is terminal. $false for the silent
      attempt, where a timeout, a denial or an interaction-required answer is an
      expected outcome meaning "fall back", not "stop".

      A STATE MISMATCH ALWAYS THROWS regardless of this switch -- it is a security
      event, never a retryable condition.

    .OUTPUTS
      [pscustomobject] Ok, Code, Verifier, RedirectUri, FailureKind, FailureMessage.
      FailureKind is one of 'timeout', 'denied', 'interaction-required', 'error'.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory = $true)] [string] $ClientId,
        [Parameter(Mandatory = $true)] [string[]] $Scope,
        [Parameter(Mandatory = $true)] [int] $TimeoutSeconds,
        [Parameter(Mandatory = $true)] [ValidateSet('none', 'consent')] [string] $PromptMode,
        [Parameter(Mandatory = $true)] [bool] $ThrowOnFailure
    )

    $verifier   = New-RandomUrlSafeString -ByteCount 32
    $challenge  = Get-PkceChallenge -Verifier $verifier
    $stateNonce = New-RandomUrlSafeString -ByteCount 32

    $port = Get-FreeLoopbackPort
    $prefix = "http://127.0.0.1:$port/"

    # Google's loopback rules for installed apps: any port is accepted regardless of
    # what is registered, so a client registered as ["http://localhost"] works here.
    # No trailing slash -- this exact string is echoed in the token exchange.
    $redirectUri = "http://127.0.0.1:$port"

    $listener = $null
    $urlFile = $null
    try {
        $listener = New-Object System.Net.HttpListener
        $listener.Prefixes.Add($prefix)
        try {
            $listener.Start()
        }
        catch [System.Net.HttpListenerException] {
            throw "Could not listen on $prefix ($($_.Exception.Message)). If this is an access-denied error, reserve the loopback URL once from an elevated prompt: netsh http add urlacl url=http://127.0.0.1:$port/ user=$env:USERDOMAIN\$env:USERNAME -- or re-run this tool as the same user that owns the reservation."
        }
        Write-RotationLog -Level 'INFO' -Message "Loopback listener bound on port $port."

        $authQuery = New-Object System.Collections.Specialized.OrderedDictionary
        $authQuery.Add('client_id', $ClientId)
        $authQuery.Add('redirect_uri', $redirectUri)
        $authQuery.Add('response_type', 'code')
        $authQuery.Add('scope', ($Scope -join ' '))
        # access_type=offline is what asks for a refresh_token at all. It is NOT
        # per-mode: both attempts need it, and dropping it makes every rotation fail
        # at the "no refresh_token" check with a message blaming prompt=consent.
        # `prompt` below is the ONLY parameter that may differ between the two modes.
        $authQuery.Add('access_type', 'offline')

        # The prompt parameter is what separates the two attempts, and it is always
        # sent explicitly -- neither mode relies on Google's default.
        #
        #   'consent' is LOAD-BEARING on the fallback path. Per the web-server
        #   documentation Google mints a refresh_token only on a fresh grant; for a
        #   client the user has already approved it can return an access token with no
        #   refresh_token, leaving the rotation with nothing to ship.
        #
        #   'none' forbids Google from rendering ANY user interface, which is what
        #   makes the silent attempt deterministic. OMITTING prompt would mean "show UI
        #   only if needed", so a lapsed session cookie parks the tab on a sign-in page
        #   that never redirects to our listener and we burn the entire silent budget
        #   before falling back. With prompt=none Google answers at once: a code when
        #   the grant is live and the session valid, otherwise interaction_required /
        #   login_required / consent_required / account_selection_required. No
        #   capability is lost by never showing sign-in here -- the consent fallback
        #   will show it if the user genuinely needs to sign in.
        $authQuery.Add('prompt', $PromptMode)
        $authQuery.Add('code_challenge', $challenge)
        $authQuery.Add('code_challenge_method', 'S256')
        $authQuery.Add('state', $stateNonce)

        $authUrl = $script:AuthEndpoint + '?' + (New-QueryString -Pairs $authQuery)

        try {
            Start-Process $authUrl
            Write-RotationLog -Level 'INFO' -Message 'Opened the default browser for Google authorization.'
        }
        catch {
            # Not fatal -- the person can open it by hand. Nothing in the URL is secret
            # (the client id is public for an installed app; the challenge and nonce are
            # single-use), but the whole query string must not go to the log, the
            # console or a transcript. It goes to a one-click .url shortcut instead,
            # which is deleted in the finally below when the attempt ends.
            Write-RotationLog -Level 'WARN' -Message "Could not launch a browser automatically: $($_.Exception.Message). Wrote a shortcut file for the user to open."
            $urlFile = Join-Path (Get-RotationRoot) 'authorize-now.url'
            Set-Content -LiteralPath $urlFile -Encoding ASCII -Value @(
                '[InternetShortcut]'
                "URL=$authUrl"
            )
            $copied = $false
            try {
                Set-Clipboard -Value $authUrl
                $copied = $true
            }
            catch {
                $copied = $false
            }

            Write-Warning 'Could not open a browser automatically.'
            Write-Host "Open this shortcut to continue: $urlFile"
            if ($copied) { Write-Host 'The authorization URL is also on your clipboard.' }
            Write-Host "Use a browser on THIS machine -- it has to reach http://127.0.0.1:$port"
        }

        $clock = [System.Diagnostics.Stopwatch]::StartNew()
        $budgetMs = $TimeoutSeconds * 1000

        while ($true) {
            $remainingMs = $budgetMs - [int]$clock.ElapsedMilliseconds
            $timedOut = $false
            if ($remainingMs -le 0) {
                $timedOut = $true
            }
            else {
                # GetContext() blocks forever with no cancellation, so the wait is done
                # on the async handle -- that is the only way the timeout is real.
                $async = $listener.BeginGetContext($null, $null)
                if (-not $async.AsyncWaitHandle.WaitOne($remainingMs)) { $timedOut = $true }
            }

            if ($timedOut) {
                $msg = "Timed out after $TimeoutSeconds seconds waiting for the Google authorization redirect. Nobody completed the browser prompt (or the browser could not reach http://127.0.0.1:$port). Re-run and finish the browser prompt, or raise -TimeoutSeconds."
                if ($ThrowOnFailure) { throw $msg }
                Write-RotationLog -Level 'WARN' -Message 'Authorization attempt did not complete (timeout).'
                return [pscustomobject]@{
                    Ok = $false; Code = $null; Verifier = $null; RedirectUri = $redirectUri
                    FailureKind = 'timeout'; FailureMessage = $msg
                }
            }

            $context = $listener.EndGetContext($async)
            $query = $context.Request.QueryString

            $gotCode  = $query['code']
            $gotError = $query['error']
            $gotState = $query['state']

            $hasCode  = -not [string]::IsNullOrEmpty($gotCode)
            $hasError = -not [string]::IsNullOrEmpty($gotError)
            $hasState = -not [string]::IsNullOrEmpty($gotState)

            if (-not $hasCode -and -not $hasError) {
                # Browsers speculatively fetch /favicon.ico and friends against the
                # origin. Answer them and keep waiting for the real redirect.
                Write-CallbackResponse -Context $context -StatusCode 404 -Html (
                    Get-CallbackHtml -Success $false -Headline 'Nothing here' -Detail 'This is a one-shot local listener for a Google sign-in redirect.')
                continue
            }

            Write-RotationLog -Level 'INFO' -Message 'Received the OAuth redirect on the loopback listener.'

            # --- state validation -------------------------------------------------
            # Ordering matters. A nonce that is PRESENT and wrong is always a security
            # event. But an ABSENT nonce alongside an `error` is Google failing before
            # it issued anything -- there is no code to inject, so reporting a CSRF
            # attempt there would bury the real cause (a denial, an unverified app, a
            # misconfigured client). An absent nonce alongside a CODE is still hostile.
            $stateIsHostile = $false
            if ($hasState) {
                if (-not ($gotState -ceq $stateNonce)) { $stateIsHostile = $true }
            }
            elseif (-not $hasError) {
                $stateIsHostile = $true
            }

            if ($stateIsHostile) {
                Write-CallbackResponse -Context $context -StatusCode 400 -Html (
                    Get-CallbackHtml -Success $false -Headline 'Request rejected' -Detail 'The sign-in response did not match the request this tool started. Nothing was saved.')
                Write-RotationLog -Level 'ERROR' -Message 'SECURITY: an OAuth callback carrying an authorization code had a missing or mismatched state nonce. Treating this as a possible CSRF / authorization-code-injection attempt against the loopback listener, not as a glitch. The response was discarded.'
                throw 'OAuth state mismatch: the callback carried a missing or different state nonce than the one this tool generated. This is a possible cross-site request forgery or code-injection attempt against the local listener, not a transient error. Nothing was exchanged and no token was changed. Close the browser, check the machine, and re-run.'
            }

            # --- Google-reported error ---------------------------------------------
            if ($hasError) {
                $kind = 'error'
                $msg = "Google refused the authorization request with error=$gotError. The refresh token was NOT rotated. Check the OAuth client's type (it must be a Desktop app), its registered redirect URIs, and that the Gmail API is enabled on the project."
                if ($gotError -ceq 'access_denied') {
                    $kind = 'denied'
                    $msg = "Consent was denied (Google returned error=access_denied). The refresh token was NOT rotated and the old one is still in place until it expires. Re-run and, on the consent screen, pick the Gmail sending account and click Allow -- also confirm that account is listed as a Test user on the OAuth consent screen, because a project in Testing status returns access_denied for anyone who is not."
                }
                elseif ($script:SilentRetryErrors -ccontains $gotError) {
                    # prompt=none saying "I would have had to ask a human". This is the
                    # NORMAL answer once the 7-day grant is retired, so it is reported
                    # as routine, not as a failure of anything.
                    $kind = 'interaction-required'
                    $msg = "Google answered error=$gotError, meaning the authorization cannot be completed without a human. A consent prompt is required."
                }

                if ($kind -eq 'interaction-required') {
                    Write-CallbackResponse -Context $context -StatusCode 200 -Html (
                        Get-CallbackHtml -Success $true -Headline 'A consent prompt is needed' -Detail 'The silent re-authorization check finished and a consent screen is opening in a moment.')
                    Write-RotationLog -Level 'INFO' -Message "Silent authorization needs a human (Google returned $gotError). This is the expected answer when the grant has been retired or the browser session has lapsed; continuing to the consent prompt."
                }
                else {
                    Write-CallbackResponse -Context $context -StatusCode 200 -Html (
                        Get-CallbackHtml -Success $false -Headline 'Authorization was not granted' -Detail 'Google reported that the authorization was declined or could not be completed.')
                    Write-RotationLog -Level 'ERROR' -Message "Google returned an authorization error on the callback: $gotError"
                }

                if ($ThrowOnFailure) { throw $msg }
                if ($kind -ne 'interaction-required') {
                    Write-RotationLog -Level 'WARN' -Message "Authorization attempt did not complete ($kind)."
                }
                return [pscustomobject]@{
                    Ok = $false; Code = $null; Verifier = $null; RedirectUri = $redirectUri
                    FailureKind = $kind; FailureMessage = $msg
                }
            }

            # --- success -------------------------------------------------------------
            Write-CallbackResponse -Context $context -StatusCode 200 -Html (
                Get-CallbackHtml -Success $true -Headline 'Authorization received' -Detail 'The rotation tool now has what it needs and is finishing up.')

            return [pscustomobject]@{
                Ok = $true; Code = $gotCode; Verifier = $verifier; RedirectUri = $redirectUri
                FailureKind = $null; FailureMessage = $null
            }
        }
    }
    finally {
        if ($null -ne $listener) {
            try { $listener.Stop() } catch { }
            try { $listener.Close() } catch { }
        }
        # The shortcut's nonce and port are dead once this attempt ends; leaving it on
        # disk would only invite someone to open a URL that can no longer work.
        if ($null -ne $urlFile) {
            try { Remove-Item -LiteralPath $urlFile -Force -ErrorAction SilentlyContinue } catch { }
        }
    }
}

function Invoke-GoogleTokenExchange {
    <#
    .SYNOPSIS
      POST the authorization code to the token endpoint and return the raw response.
    .NOTES
      Throws on an HTTP failure with Google's own error code decoded. An exchange
      failure is deliberately NOT a reason to fall back: invalid_client or a bad
      verifier would fail identically on the second attempt, so it is reported at once
      rather than costing another browser round trip on a foregone conclusion.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)] [string] $Code,
        [Parameter(Mandatory = $true)] [string] $Verifier,
        [Parameter(Mandatory = $true)] [string] $RedirectUri,
        [Parameter(Mandatory = $true)] [string] $ClientId,
        [Parameter(Mandatory = $true)] [System.Security.SecureString] $ClientSecret
    )

    $plainSecret = $null
    $body = $null
    $form = $null
    try {
        $plainSecret = ConvertFrom-SecureStringPlain -Secure $ClientSecret

        $form = New-Object System.Collections.Specialized.OrderedDictionary
        $form.Add('code', $Code)
        $form.Add('client_id', $ClientId)
        $form.Add('client_secret', $plainSecret)
        $form.Add('code_verifier', $Verifier)
        $form.Add('grant_type', 'authorization_code')
        # Must be byte-identical to the redirect_uri sent in the authorization request.
        $form.Add('redirect_uri', $RedirectUri)

        $body = New-QueryString -Pairs $form

        try {
            return (Invoke-RestMethod -Method Post -Uri $script:TokenEndpoint `
                -ContentType 'application/x-www-form-urlencoded' -Body $body)
        }
        catch {
            $detail = Get-GoogleErrorDetail -ErrorRecord $_
            Write-RotationLog -Level 'ERROR' -Message "Token exchange failed. $detail"
            throw "Google rejected the authorization-code exchange ($detail). Nothing was rotated. 'invalid_client' means the client ID/secret pair is wrong or belongs to a different OAuth client; 'invalid_grant' usually means the code was already used or more than a few minutes elapsed before it was redeemed; 'redirect_uri_mismatch' means the OAuth client is not registered as a Desktop app."
        }
    }
    finally {
        # Drop the references so no later frame can read them. .NET strings are
        # immutable, so this is scoping, not scrubbing -- there is no in-place wipe
        # available for a String and forcing a GC would not provide one either.
        $plainSecret = $null
        $body = $null
        $form = $null
    }
}

function Resolve-GoogleTokenResponse {
    <#
    .SYNOPSIS
      Validate a token response and project the fields the caller needs.
    .PARAMETER Strict
      $true throws an actionable error. $false returns Ok=$false with a Reason, which
      is what lets the silent attempt fall back instead of failing the rotation.
    .OUTPUTS
      [pscustomobject] Ok, Reason, RefreshToken, AccessToken, Scope, ExpiresIn.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory = $true)] [AllowNull()] $Response,
        [Parameter(Mandatory = $true)] [bool] $Strict
    )

    $fields = @()
    if ($null -ne $Response) { $fields = @($Response.PSObject.Properties.Name) }

    $rejection = [pscustomobject]@{
        Ok = $false; Reason = $null; RefreshToken = $null
        AccessToken = $null; Scope = $null; ExpiresIn = 0
    }

    if ($fields -notcontains 'refresh_token' -or [string]::IsNullOrWhiteSpace([string]$Response.refresh_token)) {
        if ($Strict) {
            Write-RotationLog -Level 'ERROR' -Message 'Token response contained an access token but no refresh_token.'
            throw "Google returned an access token but NO refresh_token, so there is nothing to rotate. This almost always means one of two things: prompt=consent was omitted from the authorization request (Google only mints a refresh token on a fresh grant, and can silently omit it when the client is already authorized), or the same authorization grant was reused. If prompt=consent was sent, revoke this app's access at https://myaccount.google.com/permissions for the Gmail sending account and run the rotation again."
        }
        $rejection.Reason = 'no-refresh-token'
        return $rejection
    }

    if ($fields -notcontains 'scope' -or [string]::IsNullOrWhiteSpace([string]$Response.scope)) {
        if ($Strict) {
            Write-RotationLog -Level 'ERROR' -Message 'Token response did not report any granted scope.'
            throw "Google's token response did not report a granted scope, so it cannot be confirmed that $($script:GmailSendScope) was authorized. Refusing to ship an unverified token."
        }
        $rejection.Reason = 'no-scope'
        return $rejection
    }

    $grantedScope = [string]$Response.scope
    # Exact match against a whitespace-split list, not a substring test. A substring
    # would also accept any scope merely CONTAINING this text, and would leave the
    # constant at the top of this module doing no work.
    $grantedList = @($grantedScope -split '\s+' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($grantedList -notcontains $script:GmailSendScope) {
        if ($Strict) {
            Write-RotationLog -Level 'ERROR' -Message "Granted scopes do not include gmail.send. Granted: $grantedScope"
            throw "The granted scopes do not include $($script:GmailSendScope) (Google granted: $grantedScope). A token without it cannot send mail, so it is being rejected rather than deployed. Re-run and make sure the 'Send email on your behalf' checkbox stays ticked on the consent screen."
        }
        $rejection.Reason = 'missing-gmail-send'
        return $rejection
    }

    $expiresIn = 0
    if ($fields -contains 'expires_in') {
        try { $expiresIn = [int]$Response.expires_in } catch { $expiresIn = 0 }
    }
    $accessToken = ''
    if ($fields -contains 'access_token') { $accessToken = [string]$Response.access_token }

    return [pscustomobject]@{
        Ok = $true; Reason = $null
        RefreshToken = [string]$Response.refresh_token
        AccessToken  = $accessToken
        Scope        = $grantedScope
        ExpiresIn    = $expiresIn
    }
}

function New-OAuthTokenResult {
    <#
    .SYNOPSIS
      Build the returned object with a display set that hides the tokens.
    .NOTES
      All six members stay reachable by property; only the DEFAULT formatting is
      narrowed. So a caller who invokes Get-GoogleRefreshToken without assigning the
      result gets Scope / ExpiresIn / ObtainedAt / UsedSilentPath on screen and never
      a token. UsedSilentPath is not a secret -- it is the number we are collecting.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory = $true)] $Resolved,
        [Parameter(Mandatory = $true)] [bool] $UsedSilentPath
    )

    $result = [pscustomobject]@{
        PSTypeName     = $script:ResultTypeName
        RefreshToken   = $Resolved.RefreshToken
        AccessToken    = $Resolved.AccessToken
        Scope          = $Resolved.Scope
        ExpiresIn      = $Resolved.ExpiresIn
        ObtainedAt     = (Get-Date)
        UsedSilentPath = $UsedSilentPath
    }

    $visible = [string[]]@('Scope', 'ExpiresIn', 'ObtainedAt', 'UsedSilentPath')
    $propertySet = New-Object System.Management.Automation.PSPropertySet('DefaultDisplayPropertySet', $visible)
    $standardMembers = [System.Management.Automation.PSMemberInfo[]]@($propertySet)
    $result | Add-Member -MemberType MemberSet -Name 'PSStandardMembers' -Value $standardMembers

    return $result
}


# ---------------------------------------------------------------------------
# Public surface
# ---------------------------------------------------------------------------

function Test-GoogleOAuthConfig {
    <#
    .SYNOPSIS
      Cheap offline sanity check of the OAuth client credentials.

    .DESCRIPTION
      Performs NO network call and opens NO browser -- it only checks that the values
      are shaped like a Google installed-app client, so setup can reject an obvious
      paste error before sending a human through a consent screen.

    .OUTPUTS
      [pscustomobject] with Ok [bool] and Message [string].
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory = $true)] [AllowEmptyString()] [string] $ClientId,
        [Parameter(Mandatory = $true)] [System.Security.SecureString] $ClientSecret
    )

    if ([string]::IsNullOrWhiteSpace($ClientId)) {
        return [pscustomobject]@{ Ok = $false; Message = 'Client ID is empty. Paste the OAuth client ID from Google Cloud Console > APIs & Services > Credentials.' }
    }

    $trimmed = $ClientId.Trim()
    if ($trimmed -ne $ClientId) {
        return [pscustomobject]@{ Ok = $false; Message = 'Client ID has leading or trailing whitespace. Re-paste it without surrounding spaces.' }
    }
    if (-not $trimmed.EndsWith('.apps.googleusercontent.com')) {
        return [pscustomobject]@{ Ok = $false; Message = "Client ID does not end with '.apps.googleusercontent.com'. That is the shape Google issues; check you copied the client ID and not the project id or the client secret." }
    }
    if ($trimmed.Length -le '.apps.googleusercontent.com'.Length) {
        return [pscustomobject]@{ Ok = $false; Message = 'Client ID looks truncated -- it is only the suffix with nothing in front of it.' }
    }

    # Decrypt as late as possible, inspect length only, and drop it immediately.
    $secretLength = 0
    $plain = $null
    try {
        $plain = ConvertFrom-SecureStringPlain -Secure $ClientSecret
        if ($null -ne $plain) { $secretLength = $plain.Trim().Length }
    }
    finally {
        $plain = $null
    }

    if ($secretLength -eq 0) {
        return [pscustomobject]@{ Ok = $false; Message = 'Client secret is empty. Copy it from the same OAuth client in Google Cloud Console.' }
    }
    if ($secretLength -lt 12) {
        return [pscustomobject]@{ Ok = $false; Message = "Client secret is only $secretLength characters, which is shorter than any secret Google issues. It was probably truncated on paste." }
    }

    return [pscustomobject]@{ Ok = $true; Message = 'Client ID and secret look well-formed. This check is offline; only a real rotation proves they work.' }
}

function Get-GoogleRefreshToken {
    <#
    .SYNOPSIS
      Obtain a brand-new Gmail refresh token, silently if Google allows it.

    .DESCRIPTION
      Tries a no-prompt authorization first (see the module header). If that yields a
      refresh token carrying gmail.send, it returns without anyone touching the
      keyboard. Otherwise it falls back to a full consent flow, which BLOCKS on a human
      for up to -TimeoutSeconds.

      Worst-case wall clock is roughly SilentTimeoutSeconds + TimeoutSeconds.

    .PARAMETER ClientId
      The installed-app ("Desktop app") OAuth client ID.

    .PARAMETER ClientSecret
      The matching client secret, as a SecureString. Decrypted only for the token POST.

    .PARAMETER Scope
      Scopes to request. Defaults to gmail.send alone; the result is validated to have
      actually been granted, because Google's consent screen lets a user drop scopes.

    .PARAMETER TimeoutSeconds
      Budget for the interactive consent fallback. Defaults to 300 (5 minutes).

    .PARAMETER SilentTimeoutSeconds
      Backstop for the prompt=none attempt, for the case where Google answers nothing
      at all. Defaults to 10: prompt=none forbids any UI, so both a success and a
      refusal come back in about a second, and this budget should never be reached.

    .PARAMETER ForceConsent
      Skip the silent attempt entirely and go straight to prompt=consent.

    .OUTPUTS
      [pscustomobject] RefreshToken, AccessToken, Scope, ExpiresIn, ObtainedAt,
      UsedSilentPath. The tokens are present as properties but hidden from the default
      display, so an unassigned call cannot print one to the console.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory = $true)] [ValidateNotNullOrEmpty()] [string] $ClientId,
        [Parameter(Mandatory = $true)] [System.Security.SecureString] $ClientSecret,
        [Parameter(Mandatory = $false)] [string[]] $Scope = @('https://www.googleapis.com/auth/gmail.send'),
        [Parameter(Mandatory = $false)] [ValidateRange(10, 3600)] [int] $TimeoutSeconds = 300,
        [Parameter(Mandatory = $false)] [ValidateRange(5, 300)] [int] $SilentTimeoutSeconds = 10,
        [Parameter(Mandatory = $false)] [switch] $ForceConsent
    )

    if ($null -eq $Scope -or $Scope.Count -eq 0) {
        throw 'At least one scope must be requested.'
    }

    # PS 5.1 can still negotiate TLS 1.0/1.1 by default; Google's endpoints require 1.2+.
    try {
        [Net.ServicePointManager]::SecurityProtocol =
            [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    }
    catch {
        Write-RotationLog -Level 'WARN' -Message "Could not raise SecurityProtocol to TLS 1.2: $($_.Exception.Message)"
    }

    # --- Attempt 1: silent (prompt=none) ------------------------------------------
    if (-not $ForceConsent) {
        Write-RotationLog -Level 'INFO' -Message "Attempting silent re-authorization (prompt=none), backstop ${SilentTimeoutSeconds}s."
        Write-Host 'Trying silent re-authorization (no click expected; answers in about a second)...'

        $silentAuth = Get-GoogleAuthorizationCode -ClientId $ClientId -Scope $Scope `
            -TimeoutSeconds $SilentTimeoutSeconds -PromptMode 'none' -ThrowOnFailure $false

        if ($silentAuth.Ok) {
            $silentResponse = Invoke-GoogleTokenExchange -Code $silentAuth.Code -Verifier $silentAuth.Verifier `
                -RedirectUri $silentAuth.RedirectUri -ClientId $ClientId -ClientSecret $ClientSecret

            $silentResolved = Resolve-GoogleTokenResponse -Response $silentResponse -Strict $false
            if ($silentResolved.Ok) {
                Write-RotationLog -Level 'INFO' -Message "Rotation used the SILENT path (no consent click was required). Scopes granted: $($silentResolved.Scope)"
                Write-Host 'Silent re-authorization succeeded; no consent click was needed.'
                return (New-OAuthTokenResult -Resolved $silentResolved -UsedSilentPath $true)
            }

            Write-RotationLog -Level 'WARN' -Message "Silent path exchanged but the response was unusable ($($silentResolved.Reason)). Falling back to prompt=consent."
        }
        elseif ($silentAuth.FailureKind -eq 'interaction-required') {
            # Routine, and logged as such by the attempt itself. A human is needed --
            # which is the whole reason this tool exists -- so this is not a warning.
            Write-RotationLog -Level 'INFO' -Message 'Silent path is unavailable; a consent prompt is required. Continuing.'
        }
        else {
            Write-RotationLog -Level 'WARN' -Message "Silent path did not complete ($($silentAuth.FailureKind)). Falling back to prompt=consent."
        }

        # prompt=none guarantees Google renders nothing, so the silent tab has already
        # landed on our own callback page rather than parking on a sign-in screen. The
        # fallback below opens a SECOND tab; the first is inert (its listener is closed
        # and its nonce is dead) but say so, or it reads as a bug.
        Write-Host 'Silent re-authorization is unavailable. Opening a consent prompt -- you can close the earlier tab.'
    }
    else {
        Write-RotationLog -Level 'INFO' -Message 'ForceConsent was requested; skipping the silent attempt.'
    }

    # --- Attempt 2: interactive consent -------------------------------------------
    # Fresh everything. Get-GoogleAuthorizationCode mints its own PKCE pair, state
    # nonce, port and listener per call, so nothing from attempt 1 carries over.
    Write-Host "Waiting up to $TimeoutSeconds seconds for Google consent in your browser..."

    $auth = Get-GoogleAuthorizationCode -ClientId $ClientId -Scope $Scope `
        -TimeoutSeconds $TimeoutSeconds -PromptMode 'consent' -ThrowOnFailure $true

    if (-not $auth.Ok -or [string]::IsNullOrEmpty($auth.Code)) {
        # Defensive: with -ThrowOnFailure every non-success path above throws.
        throw 'No authorization code was captured from the Google redirect.'
    }

    $response = Invoke-GoogleTokenExchange -Code $auth.Code -Verifier $auth.Verifier `
        -RedirectUri $auth.RedirectUri -ClientId $ClientId -ClientSecret $ClientSecret

    Write-RotationLog -Level 'INFO' -Message 'Authorization code exchanged for tokens.'

    $resolved = Resolve-GoogleTokenResponse -Response $response -Strict $true

    Write-RotationLog -Level 'INFO' -Message "Rotation used the CONSENT path (a human clicked Allow). Scopes granted: $($resolved.Scope)"

    return (New-OAuthTokenResult -Resolved $resolved -UsedSilentPath $false)
}

Export-ModuleMember -Function @(
    'Get-GoogleRefreshToken'
    'Test-GoogleOAuthConfig'
)
