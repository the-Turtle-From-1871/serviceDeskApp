<#
.SYNOPSIS
  Windows plumbing for the Gmail refresh-token rotation tool: toasts, protocol
  handler, Start Menu shortcut and the every-6-hours scheduled task.

.DESCRIPTION
  Google's consent screen requires one human click per rotation and that cannot be
  automated. Everything in this module exists to make that click convenient and
  unmissable:

    * a scheduled task runs `rotate-gmail-token.ps1 -Mode Check` every 6 hours,
    * `Show-RotationToast` raises a toast whose urgency escalates as expiry nears,
    * the toast's button protocol-activates `dcsim-gmail-rotate:`, which launches
      `rotate-gmail-token.ps1 -Mode Rotate` in the user's interactive session.

  Everything is PER-USER: HKCU, %APPDATA%, and a task registered in the interactive
  user's context. NOTHING here needs elevation, and nothing is written to HKLM or
  to %ProgramData%.

  No secret is ever passed to, or rendered by, anything in this file. Toast text is
  caller-supplied and XML-escaped; callers must not put a token in it.

  Windows PowerShell 5.1, Windows 11. No ternary, no ??, no pipeline chain operators.
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

# --------------------------------------------------------------------------------
# Constants. These four strings are the contract between the toast, the protocol
# handler, the shortcut and the scheduled task -- change one and you must change
# the others, or the toast button stops launching anything.
# --------------------------------------------------------------------------------

# The AppUserModelID. A toast raised by an unpackaged app is attributed to whatever
# AUMID it was raised under; without a Start Menu shortcut carrying this exact
# string the notification platform has no app to attribute it to and the toast is
# silently dropped (or shows as "Windows PowerShell"). Register-RotationShortcut
# is what puts it on disk.
$script:Aumid = 'DCSIM.GmailTokenRotation'

# Stub COM CLSID for System.AppUserModel.ToastActivatorCLSID. Microsoft's guidance
# for UNPACKAGED desktop apps is to put a CLSID -- any fixed random GUID -- on the
# shortcut and NOT implement the COM activator. Its only job is to make Action
# Center PERSIST the notification instead of letting it vanish with the popup,
# which for a "you must click this within N days" reminder is the whole point.
#
# The documented consequence: with a stub CLSID and no COM server, only
# activationType="protocol" activations work. That is exactly (and only) what this
# module emits -- see New-RotationToastXml. Do NOT add a foreground/background
# toast button here; it would bind to a COM server that does not exist and do
# nothing when clicked.
$script:ToastActivatorClsid = '{6B1D3A2E-9C47-4F58-B0E1-7A3C2D5E8F41}'

$script:ProtocolScheme = 'dcsim-gmail-rotate'
$script:ProtocolUri    = 'dcsim-gmail-rotate:'

$script:TaskName     = 'Gmail Token Rotation Check'
$script:TaskPath     = '\DCSIM\'
$script:ShortcutName = 'DCSIM Gmail Token Rotation.lnk'
$script:AppDisplayName = 'DCSIM Gmail Token Rotation'

# --------------------------------------------------------------------------------
# Paths
# --------------------------------------------------------------------------------

function Get-RotationScriptPath {
    <#
    .SYNOPSIS
      Absolute path to the orchestrator the toast button and the task both launch.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param()

    return (Join-Path $PSScriptRoot 'rotate-gmail-token.ps1')
}

function Get-RotationShortcutPath {
    <#
    .SYNOPSIS
      Absolute path to the per-user Start Menu shortcut that carries the AUMID.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param()

    $programs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
    return (Join-Path $programs $script:ShortcutName)
}

function Get-RotationProtocolKeyPath {
    <#
    .SYNOPSIS
      HKCU registry path of the protocol handler root key.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param()

    return "HKCU:\Software\Classes\$($script:ProtocolScheme)"
}

function Get-PowerShellExePath {
    <#
    .SYNOPSIS
      Full path to the Windows PowerShell 5.1 host used by the task and the handler.
    .NOTES
      Resolved to an absolute path rather than left as a bare "powershell.exe": a
      scheduled task and a shell protocol handler do not necessarily inherit a PATH
      that resolves it.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param()

    return (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
}

# --------------------------------------------------------------------------------
# Shortcut installer (COM interop)
#
# A .lnk gets an AUMID only through IShellLink's IPropertyStore -- WScript.Shell
# cannot set shell properties at all, so the usual New-Object -ComObject
# WScript.Shell recipe produces a shortcut that looks right and raises no toast.
# The two property keys are documented as:
#   System.AppUserModel.ID                 fmtid 9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3 pid 5  (String)
#   System.AppUserModel.ToastActivatorCLSID fmtid 9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3 pid 26 (Guid)
# --------------------------------------------------------------------------------

function Initialize-RotationShortcutType {
    [CmdletBinding()]
    param()

    # Add-Type throws if the type is already in the AppDomain, which -Force
    # re-imports of this module would otherwise trigger.
    if ($null -ne ([System.Management.Automation.PSTypeName]'DcsimRotation.ShortcutInstaller').Type) { return }

    $source = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace DcsimRotation
{
    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    internal class CShellLink { }

    [ComImport,
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown),
     Guid("000214F9-0000-0000-C000-000000000046")]
    internal interface IShellLinkW
    {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszFile, int cch, IntPtr pfd, uint fFlags);
        void GetIDList(out IntPtr ppidl);
        void SetIDList(IntPtr pidl);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszName, int cch);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszDir, int cch);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszArgs, int cch);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
        void GetHotkey(out short pwHotkey);
        void SetHotkey(short wHotkey);
        void GetShowCmd(out int piShowCmd);
        void SetShowCmd(int iShowCmd);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszIconPath, int cch, out int piIcon);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, uint dwReserved);
        void Resolve(IntPtr hwnd, uint fFlags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
    }

    [ComImport,
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown),
     Guid("0000010b-0000-0000-C000-000000000046")]
    internal interface IPersistFile
    {
        void GetClassID(out Guid pClassID);
        [PreserveSig] int IsDirty();
        void Load([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, uint dwMode);
        void Save([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, [MarshalAs(UnmanagedType.Bool)] bool fRemember);
        void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string pszFileName);
        void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string ppszFileName);
    }

    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    internal struct PropertyKey
    {
        public Guid fmtid;
        public uint pid;
        public PropertyKey(Guid formatId, uint propertyId)
        {
            fmtid = formatId;
            pid = propertyId;
        }
    }

    // PROPVARIANT: 8-byte header then a union. Two IntPtrs give the correct total
    // size on both x86 (16 bytes) and x64 (24 bytes).
    [StructLayout(LayoutKind.Sequential)]
    internal struct PropVariant
    {
        public ushort vt;
        public ushort wReserved1;
        public ushort wReserved2;
        public ushort wReserved3;
        public IntPtr p;
        public IntPtr p2;
    }

    [ComImport,
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown),
     Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99")]
    internal interface IPropertyStore
    {
        void GetCount(out uint cProps);
        void GetAt(uint iProp, out PropertyKey pkey);
        void GetValue(ref PropertyKey key, out PropVariant pv);
        void SetValue(ref PropertyKey key, ref PropVariant pv);
        void Commit();
    }

    public static class ShortcutInstaller
    {
        private const ushort VT_LPWSTR = 31;
        private const ushort VT_CLSID = 72;

        private static readonly Guid AppUserModelFmtId =
            new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");

        [DllImport("ole32.dll")]
        private static extern int PropVariantClear(ref PropVariant pvar);

        /// <summary>
        /// Create (or replace) a .lnk carrying System.AppUserModel.ID and the stub
        /// System.AppUserModel.ToastActivatorCLSID, which is what makes toasts
        /// raised under that AUMID display and persist in Action Center.
        /// </summary>
        public static void Install(
            string shortcutPath,
            string targetPath,
            string arguments,
            string workingDirectory,
            string description,
            string appUserModelId,
            string toastActivatorClsid)
        {
            IShellLinkW link = (IShellLinkW)new CShellLink();
            // The release is in a finally: any throw between here and Save (a bad CLSID
            // string, a denied write to the Start Menu folder) would otherwise leak the
            // RCW. IPropertyStore and IPersistFile below are QueryInterface'd off this
            // same object, so the runtime hands back the SAME RCW for all three and one
            // release covers them.
            try
            {
                link.SetPath(targetPath);
                link.SetArguments(arguments);
                link.SetWorkingDirectory(workingDirectory);
                link.SetDescription(description);
                link.SetIconLocation(targetPath, 0);

                IPropertyStore store = (IPropertyStore)link;

                PropertyKey aumidKey = new PropertyKey(AppUserModelFmtId, 5);
                PropVariant aumidValue = new PropVariant();
                aumidValue.vt = VT_LPWSTR;
                aumidValue.p = Marshal.StringToCoTaskMemUni(appUserModelId);
                try
                {
                    store.SetValue(ref aumidKey, ref aumidValue);
                }
                finally
                {
                    PropVariantClear(ref aumidValue);
                }

                PropertyKey clsidKey = new PropertyKey(AppUserModelFmtId, 26);
                PropVariant clsidValue = new PropVariant();
                clsidValue.vt = VT_CLSID;
                IntPtr guidMemory = Marshal.AllocCoTaskMem(16);
                Marshal.Copy(new Guid(toastActivatorClsid).ToByteArray(), 0, guidMemory, 16);
                clsidValue.p = guidMemory;
                try
                {
                    store.SetValue(ref clsidKey, ref clsidValue);
                }
                finally
                {
                    PropVariantClear(ref clsidValue);
                }

                store.Commit();

                IPersistFile file = (IPersistFile)link;
                file.Save(shortcutPath, true);
            }
            finally
            {
                Marshal.ReleaseComObject(link);
            }
        }
    }
}
'@

    Add-Type -TypeDefinition $source -Language CSharp
}

# --------------------------------------------------------------------------------
# Toasts
# --------------------------------------------------------------------------------

function New-RotationToastXml {
    <#
    .SYNOPSIS
      Build the toast XML for a level. Internal.
    .NOTES
      Every caller-supplied string is XML-escaped. The only activation used anywhere
      in this XML is activationType="protocol" -- see the stub-CLSID note at the top
      of this file for why nothing else can work.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory = $true)] [ValidateSet('Info', 'Warn', 'Critical')] [string] $Level,
        [Parameter(Mandatory = $true)] [string] $Title,
        [Parameter(Mandatory = $true)] [string] $Message,
        [Parameter(Mandatory = $false)] [switch] $Actionable
    )

    $safeTitle   = [System.Security.SecurityElement]::Escape($Title)
    $safeMessage = [System.Security.SecurityElement]::Escape($Message)

    # duration="long" keeps the popup up for ~25s instead of ~7s.
    #
    # scenario: "urgent" (Windows 11) is the one that stays on screen until
    # dismissed AND is allowed to break through Focus Assist / Do Not Disturb.
    # Deliberately NOT "reminder", which is documented to be "silently ignored
    # unless there's a toast button action that activates in background" -- our
    # only button is protocol-activated, so a reminder scenario would degrade to
    # an ordinary toast that disappears after a few seconds. Exactly the failure
    # mode a critical expiry warning must not have.
    if ($Level -eq 'Critical') {
        $toastAttributes = 'duration="long" scenario="urgent"'
        $attribution     = 'Rotate now - the sender stops working when this expires.'
        $buttonLabel     = 'Rotate now'
    }
    elseif ($Level -eq 'Warn') {
        $toastAttributes = 'duration="long"'
        $attribution     = 'One browser click is all it takes.'
        $buttonLabel     = 'Rotate now'
    }
    else {
        $toastAttributes = 'duration="short"'
        $attribution     = 'DCSIM Gmail token rotation'
        $buttonLabel     = 'Rotate now'
    }

    $safeAttribution = [System.Security.SecurityElement]::Escape($attribution)

    if ($Actionable) {
        # Clicking the toast BODY and clicking the button both fire the same
        # protocol URI, so there is no dead area on the notification.
        $launchAttribute = " launch=""$($script:ProtocolUri)"" activationType=""protocol"""
        # ONE button, and it is protocol-activated. No foreground/background/system
        # action is added: the stub ToastActivatorCLSID breaks every activation type
        # except protocol, so any other button would render and then do nothing.
        $actionsXml = @"
  <actions>
    <action content="$([System.Security.SecurityElement]::Escape($buttonLabel))" arguments="$($script:ProtocolUri)" activationType="protocol" />
  </actions>
"@
    }
    else {
        $launchAttribute = ''
        $actionsXml = ''
    }

    return @"
<toast $toastAttributes$launchAttribute>
  <visual>
    <binding template="ToastGeneric">
      <text>$safeTitle</text>
      <text>$safeMessage</text>
      <text placement="attribution">$safeAttribution</text>
    </binding>
  </visual>
$actionsXml
</toast>
"@
}

function Get-NotificationSettingRemedy {
    <#
    .SYNOPSIS
      Plain-English "which toggle to undo" for a non-Enabled ToastNotifier.Setting. Internal.
    .NOTES
      Every one of these states makes Windows DROP the toast without raising anything --
      Show() returns normally and the notification simply never appears. Each has a
      different cure, and naming the wrong one sends the operator to a Settings page that
      looks perfectly fine, so the value is reported verbatim as well.

      The documented members of Windows.UI.Notifications.NotificationSetting are Enabled,
      DisabledForApplication, DisabledForUser, DisabledByGroupPolicy and
      DisabledByManifest. Anything else falls through to the generic branch rather than
      being silently treated as fine.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        # AllowEmptyString: a mandatory non-empty [string] threw here when Setting came back
        # empty, turning a diagnostic helper into a second failure on top of the first.
        [Parameter(Mandatory = $true)] [AllowEmptyString()] [string] $Setting
    )

    if ([string]::IsNullOrWhiteSpace($Setting)) {
        return 'Windows did not report a notification setting for this app, so it could not be checked.'
    }

    if ($Setting -eq 'DisabledForApplication') {
        return "Notifications are switched off for THIS app. Settings > System > Notifications > '$($script:AppDisplayName)' -- switch it back on."
    }
    if ($Setting -eq 'DisabledForUser' -or $Setting -eq 'NotificationsDisabled') {
        return 'Notifications are switched off for this Windows user. Settings > System > Notifications -- switch the master "Notifications" toggle back on.'
    }
    if ($Setting -eq 'DisabledByGroupPolicy') {
        return 'Notifications are blocked by group policy (NoToastApplicationNotification). An administrator has to change the policy; until then this tool cannot reach anyone.'
    }
    if ($Setting -eq 'DisabledByManifest') {
        return 'The platform says the registered app forbids toasts. Re-run setup.ps1 to rewrite the Start Menu shortcut that carries the AppUserModelID.'
    }
    return 'This is not a state this tool recognises. Check Settings > System > Notifications for this app and for the machine.'
}

function Show-RotationToast {
    <#
    .SYNOPSIS
      Raise a toast notification under this tool's own AppUserModelID.
    .PARAMETER Level
      Info / Warn / Critical. Critical uses the "urgent" scenario, so it stays on
      screen until dismissed and pierces Focus Assist.
    .PARAMETER Actionable
      Adds a "Rotate now" button (and makes the toast body clickable) that
      protocol-activates the rotation via dcsim-gmail-rotate:.
    .NOTES
      Never pass a token, client secret or hook URL in -Title/-Message: a toast is
      persisted in Action Center and rendered on a possibly-shared screen.

      This function does not throw. A notification platform failure must not be the
      reason a scheduled -Mode Check run dies; the failure is written to the log
      instead.

      RETURN CONTRACT: $true ONLY when the toast was accepted by the platform with
      notifications actually enabled for this AUMID. $false means NOTHING reached a
      human -- which for this tool is the whole failure mode, so every $false is
      accompanied by an ERROR (or, for the deliberate self-heal deferral, a WARN) log
      line naming the specific cause. Callers are expected to act on it: the
      orchestrator exits non-zero, which surfaces in Task Scheduler's Last Run Result.
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter(Mandatory = $true)] [ValidateSet('Info', 'Warn', 'Critical')] [string] $Level,
        [Parameter(Mandatory = $true)] [string] $Title,
        [Parameter(Mandatory = $true)] [string] $Message,
        [Parameter(Mandatory = $false)] [switch] $Actionable
    )

    try {
        # Self-heal: a missing shortcut means the AUMID is unknown to the platform
        # and the toast would be dropped without an error anyone would ever see.
        #
        # The toast is deliberately NOT raised on the same run that recreates the
        # shortcut. Registering an AUMID is asynchronous inside the notification
        # platform, so a toast raised moments later races the indexing and can be
        # dropped -- and dropped THAT way is invisible: Setting still reads Enabled
        # and Show() still returns, so we would report a delivery that never
        # happened. That is exactly the lie the Setting check below exists to stop,
        # and a sleep long enough to be reliable is not a duration we can justify
        # from here. Deferring costs one 6-hour cycle out of a 3-day budget; the
        # $false return still makes the run visibly abnormal.
        if (-not (Test-Path -LiteralPath (Get-RotationShortcutPath))) {
            Write-RotationLog -Level 'WARN' -Message 'Start Menu shortcut missing; re-registering so the toast has an AppUserModelID.'
            Register-RotationShortcut | Out-Null
            Write-RotationLog -Level 'WARN' -Message "No toast was raised this run (level=$Level): the AppUserModelID had to be re-registered first and the platform may not have indexed it yet. The next check, within 6 hours, will notify."
            return $false
        }

        [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]
        [void][Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType=WindowsRuntime]
        [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime]

        $xmlText = New-RotationToastXml -Level $Level -Title $Title -Message $Message -Actionable:$Actionable

        $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
        $xml.LoadXml($xmlText)

        $toast = New-Object Windows.UI.Notifications.ToastNotification $xml

        # Tag + Group make a new toast REPLACE the previous one rather than stacking
        # six identical reminders in Action Center over a day and a half of 6-hourly
        # checks. Tag is capped at 64 chars by the platform.
        $toast.Tag = 'gmail-refresh-token'
        $toast.Group = 'dcsim-rotation'

        $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($script:Aumid)

        # THE SILENT-DROP CHECK. Windows does not raise anything when notifications
        # have been switched off for this AUMID -- Show() returns normally and the
        # toast goes nowhere, so the try/catch below cannot see it. Setting is the
        # only signal that exists, and it must be read BEFORE showing. Without this
        # one accidental Settings toggle makes the tool permanently and invisibly
        # mute while the token expires, which is worse than not having the tool.
        # This check FAILS OPEN, and that is load-bearing. Windows PowerShell 5.1's WinRT
        # projection does not reliably surface ToastNotifier.Setting -- on this machine it
        # comes back as an EMPTY STRING rather than a NotificationSetting value. The first
        # version of this guard treated anything that was not 'Enabled' as disabled, so an
        # unreadable setting suppressed every toast and the tool went completely silent:
        # the guard became the outage it existed to prevent. Refusing to notify because we
        # could not confirm we are allowed to notify is strictly worse than the silent drop
        # being guarded against. So: only an EXPLICIT disabled value blocks the toast.
        $setting = ''
        try {
            $setting = [string] $notifier.Setting
        }
        catch {
            $setting = ''
            Write-RotationLog -Level 'WARN' -Message "Could not read the notification setting for AUMID '$($script:Aumid)' ($($_.Exception.Message)); showing the toast anyway."
        }

        if (-not [string]::IsNullOrWhiteSpace($setting) -and $setting -ne 'Enabled') {
            Write-RotationLog -Level 'ERROR' -Message "Toast NOT delivered (level=$Level): Windows reports notification setting '$setting' for '$($script:AppDisplayName)' (AUMID $($script:Aumid)). $(Get-NotificationSettingRemedy -Setting $setting) Until that is undone nothing will warn anyone that the Gmail token is expiring."
            return $false
        }

        $notifier.Show($toast)

        $reported = $setting
        if ([string]::IsNullOrWhiteSpace($reported)) { $reported = 'unreadable (assumed enabled)' }
        Write-RotationLog -Level 'INFO' -Message "Toast shown (level=$Level, actionable=$([bool]$Actionable), setting=$reported)."
        return $true
    }
    catch {
        Write-RotationLog -Level 'ERROR' -Message "Could not show toast (level=$Level): $($_.Exception.Message)"
        return $false
    }
}

# --------------------------------------------------------------------------------
# Protocol handler
# --------------------------------------------------------------------------------

function Register-RotationProtocolHandler {
    <#
    .SYNOPSIS
      Register the dcsim-gmail-rotate: URI scheme under HKCU.
    .DESCRIPTION
      HKCU\Software\Classes only -- a per-user class registration needs no admin
      rights and cannot affect another account on the machine.

      Idempotent: an existing registration is overwritten in place, so re-running
      setup after moving the repository repoints the handler at the new path.
    #>
    [CmdletBinding()]
    param()

    $keyPath    = Get-RotationProtocolKeyPath
    $scriptPath = Get-RotationScriptPath
    $psExe      = Get-PowerShellExePath

    # NOTE ON "%1": a protocol handler command normally receives the invoked URI.
    # This command deliberately contains no %1, and that was verified empirically
    # on Windows 11 -- the shell does NOT append the URI when the command string
    # omits it, so the orchestrator is launched with exactly the arguments below
    # and no stray trailing positional argument to bind. That also means no
    # attacker-controlled text ever reaches the command line: any local process can
    # invoke an HKCU protocol, so keeping the URI out entirely is what makes this
    # handler injection-proof. Do not add %1 "for completeness".
    $command = '"{0}" -NoProfile -ExecutionPolicy Bypass -File "{1}" -Mode Rotate' -f $psExe, $scriptPath

    if (-not (Test-Path -LiteralPath $keyPath)) {
        New-Item -Path $keyPath -Force | Out-Null
    }
    Set-ItemProperty -Path $keyPath -Name '(default)' -Value "URL:$($script:AppDisplayName)"
    Set-ItemProperty -Path $keyPath -Name 'URL Protocol' -Value ''

    $commandKey = Join-Path $keyPath 'shell\open\command'
    if (-not (Test-Path -LiteralPath $commandKey)) {
        New-Item -Path $commandKey -Force | Out-Null
    }
    Set-ItemProperty -Path $commandKey -Name '(default)' -Value $command

    Write-RotationLog -Level 'INFO' -Message "Registered protocol handler '$($script:ProtocolScheme):'."
    return $keyPath
}

# --------------------------------------------------------------------------------
# Start Menu shortcut (supplies the AppUserModelID)
# --------------------------------------------------------------------------------

function Register-RotationShortcut {
    <#
    .SYNOPSIS
      Install the per-user Start Menu shortcut that carries the AppUserModelID.
    .DESCRIPTION
      Two jobs in one file:
        1. It is the documented prerequisite for an unpackaged app to raise a toast
           at all -- the AUMID on this .lnk is what the notification platform
           resolves to an app name and icon.
        2. It is a normal Start Menu entry, so typing "DCSIM Gmail" into Start runs
           a rotation by hand without anyone remembering a script path.

      Idempotent: the .lnk is rewritten from scratch on every call.
    #>
    [CmdletBinding()]
    param()

    Initialize-RotationShortcutType

    $shortcutPath = Get-RotationShortcutPath
    $parent = Split-Path -Parent $shortcutPath
    if (-not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }

    $scriptPath = Get-RotationScriptPath
    $psExe      = Get-PowerShellExePath
    # Quoted so a repository path containing spaces still resolves.
    $arguments  = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -Mode Rotate' -f $scriptPath

    [DcsimRotation.ShortcutInstaller]::Install(
        $shortcutPath,
        $psExe,
        $arguments,
        $PSScriptRoot,
        'Rotate the Gmail OAuth refresh token',
        $script:Aumid,
        $script:ToastActivatorClsid)

    Write-RotationLog -Level 'INFO' -Message "Registered Start Menu shortcut with AUMID '$($script:Aumid)'."
    return $shortcutPath
}

# --------------------------------------------------------------------------------
# Scheduled task
# --------------------------------------------------------------------------------

function Register-RotationScheduledTask {
    <#
    .SYNOPSIS
      Register (or replace) the every-6-hours `-Mode Check` task.
    .DESCRIPTION
      The task runs in the INTERACTIVE user's context, not as SYSTEM and not
      "whether the user is logged on or not".

      That is a hard requirement, not a preference. The whole purpose of the check
      is to raise a toast and -- when the human clicks it -- open a browser for
      Google's consent screen. A task running in session 0, or under a stored
      password with the user logged off, has no desktop: the toast goes nowhere and
      the browser can never appear. So: LogonType Interactive, RunLevel Limited, no
      -Password. The cost is that the check simply does not run while nobody is
      logged on, which -StartWhenAvailable then covers by firing the missed run
      once someone signs in.

      Idempotent: -Force replaces an existing registration rather than erroring.
    #>
    [CmdletBinding()]
    param()

    $scriptPath = Get-RotationScriptPath
    $psExe      = Get-PowerShellExePath

    $action = New-ScheduledTaskAction `
        -Execute $psExe `
        -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Mode Check' -f $scriptPath) `
        -WorkingDirectory $PSScriptRoot

    # Omitting -RepetitionDuration means "repeat indefinitely" on Windows 10/11.
    # The first run is offset a couple of minutes so setup.ps1 does not race a
    # check against the config it has only just written.
    $trigger = New-ScheduledTaskTrigger `
        -Once `
        -At (Get-Date).AddMinutes(2) `
        -RepetitionInterval (New-TimeSpan -Hours 6)

    $settings = New-ScheduledTaskSettingsSet `
        -StartWhenAvailable `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -MultipleInstances IgnoreNew `
        -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
        -Compatibility Win8
    # -AllowStartIfOnBatteries + -DontStopIfGoingOnBatteries together undo the
    # Task Scheduler default of refusing to start (and killing) tasks on battery.
    # Without both, a laptop unplugged for a day never checks and the token dies
    # quietly. -StartWhenAvailable is what makes a run missed during sleep fire on
    # wake instead of being skipped until the next 6-hour boundary.

    $userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $principal = New-ScheduledTaskPrincipal `
        -UserId $userId `
        -LogonType Interactive `
        -RunLevel Limited

    $registered = Register-ScheduledTask `
        -TaskName $script:TaskName `
        -TaskPath $script:TaskPath `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings `
        -Principal $principal `
        -Description 'Checks the age of the Gmail OAuth refresh token every 6 hours and notifies when it needs rotating.' `
        -Force

    Write-RotationLog -Level 'INFO' -Message "Registered scheduled task '$($script:TaskPath)$($script:TaskName)' (every 6 hours, interactive)."
    return $registered
}

# --------------------------------------------------------------------------------
# Removal + status
# --------------------------------------------------------------------------------

function Unregister-RotationIntegration {
    <#
    .SYNOPSIS
      Remove the scheduled task, protocol handler and Start Menu shortcut.
    .DESCRIPTION
      Deliberately leaves config.xml, state.json and rotate.log in place -- removing
      the Windows plumbing is not the same request as destroying the stored
      credentials or the audit trail. setup.ps1 -Uninstall asks about those
      separately.

      Safe to call when nothing is registered; each step is best-effort and reports
      what it actually removed.
    #>
    [CmdletBinding()]
    param()

    $removed = @()

    $task = Get-ScheduledTask -TaskName $script:TaskName -TaskPath $script:TaskPath -ErrorAction SilentlyContinue
    if ($null -ne $task) {
        Unregister-ScheduledTask -TaskName $script:TaskName -TaskPath $script:TaskPath -Confirm:$false
        $removed += 'scheduled task'
    }

    # Best-effort tidy of the now-empty \DCSIM\ task folder. The ScheduledTasks
    # module cannot delete a folder, so this drops to the Schedule.Service COM API.
    # A failure here is cosmetic and must not fail the uninstall.
    try {
        $service = New-Object -ComObject 'Schedule.Service'
        $service.Connect()
        $root = $service.GetFolder('\')
        $folderName = $script:TaskPath.Trim('\')
        $folder = $root.GetFolder($folderName)
        if ($folder.GetTasks(0).Count -eq 0 -and $folder.GetFolders(0).Count -eq 0) {
            $root.DeleteFolder($folderName, 0)
        }
    }
    catch {
        Write-Verbose "Could not remove task folder: $($_.Exception.Message)"
    }

    $keyPath = Get-RotationProtocolKeyPath
    if (Test-Path -LiteralPath $keyPath) {
        Remove-Item -LiteralPath $keyPath -Recurse -Force
        $removed += 'protocol handler'
    }

    $shortcutPath = Get-RotationShortcutPath
    if (Test-Path -LiteralPath $shortcutPath) {
        Remove-Item -LiteralPath $shortcutPath -Force
        $removed += 'Start Menu shortcut'
    }

    if ($removed.Count -eq 0) {
        Write-RotationLog -Level 'INFO' -Message 'Unregister requested but nothing was registered.'
    }
    else {
        Write-RotationLog -Level 'INFO' -Message "Removed: $($removed -join ', '). Config, state and log were left in place."
    }

    return $removed
}

function Get-RotationIntegrationStatus {
    <#
    .SYNOPSIS
      Report which pieces of the Windows integration are currently installed.
    .OUTPUTS
      PSCustomObject: TaskRegistered [bool], HandlerRegistered [bool],
      ShortcutExists [bool], NextRunTime [datetime] or $null.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param()

    $task = Get-ScheduledTask -TaskName $script:TaskName -TaskPath $script:TaskPath -ErrorAction SilentlyContinue
    $taskRegistered = ($null -ne $task)

    $nextRun = $null
    if ($taskRegistered) {
        try {
            $info = Get-ScheduledTaskInfo -TaskName $script:TaskName -TaskPath $script:TaskPath -ErrorAction Stop
            if ($null -ne $info -and $null -ne $info.NextRunTime) {
                $nextRun = [datetime]$info.NextRunTime
            }
        }
        catch {
            Write-Verbose "Could not read task info: $($_.Exception.Message)"
        }
    }

    # A handler counts as registered only when the command value is actually there;
    # a bare key with no command would launch nothing.
    $handlerRegistered = $false
    $commandKey = Join-Path (Get-RotationProtocolKeyPath) 'shell\open\command'
    if (Test-Path -LiteralPath $commandKey) {
        $value = (Get-ItemProperty -LiteralPath $commandKey -Name '(default)' -ErrorAction SilentlyContinue)
        if ($null -ne $value -and -not [string]::IsNullOrWhiteSpace([string]$value.'(default)')) {
            $handlerRegistered = $true
        }
    }

    return [pscustomobject]@{
        TaskRegistered    = $taskRegistered
        HandlerRegistered = $handlerRegistered
        ShortcutExists    = (Test-Path -LiteralPath (Get-RotationShortcutPath))
        NextRunTime       = $nextRun
    }
}

Export-ModuleMember -Function @(
    'Show-RotationToast'
    'Register-RotationProtocolHandler'
    'Register-RotationScheduledTask'
    'Register-RotationShortcut'
    'Unregister-RotationIntegration'
    'Get-RotationIntegrationStatus'
    'Get-RotationScriptPath'
    'Get-RotationShortcutPath'
    'Get-RotationProtocolKeyPath'
)
