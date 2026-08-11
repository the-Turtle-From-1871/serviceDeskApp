' Launch a PowerShell script with NO console window, and pass its exit code back.
'
' Why this exists: the Scheduled Task runs every few minutes with an Interactive
' logon type (required, because the import secret is DPAPI-encrypted and an S4U
' logon cannot reach the user's DPAPI master key). An Interactive task flashes a
' console window on every run -- 288 times a day. `powershell.exe -WindowStyle
' Hidden` still flashes briefly before the window style is applied; WScript.Shell
' .Run with intWindowStyle 0 never creates a visible window at all.
'
' WScript.Quit(sh.Run(...)) is load-bearing: bWaitOnReturn = True makes Run
' return PowerShell's exit code, and passing it to Quit is what lets Task
' Scheduler's "Last Run Result" reflect a real import failure instead of always
' reporting 0.
'
' Usage: wscript.exe //nologo Run-Hidden.vbs <script.ps1> [args...]

Option Explicit

Dim args, cmd, i, sh

Set args = WScript.Arguments
If args.Count < 1 Then
  WScript.Quit 1
End If

cmd = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & args(0) & """"

For i = 1 To args.Count - 1
  cmd = cmd & " " & args(i)
Next

Set sh = CreateObject("WScript.Shell")
WScript.Quit sh.Run(cmd, 0, True)
