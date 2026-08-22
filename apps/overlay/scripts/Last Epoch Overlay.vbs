Option Explicit

' The stable entry point for an install root. Windows runs .vbs files through
' wscript.exe, so opening or pinning this file never creates a console window.
'
' An updater supplies its own process id as the first argument. Waiting here,
' outside the retiring Electron process, prevents the single-instance lock from
' making the freshly installed overlay immediately exit.

Const APP_EXE = "Last Epoch Overlay.exe"

Dim fileSystem, shell, installRoot, latestFolder
Set fileSystem = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

installRoot = fileSystem.GetParentFolderName(WScript.ScriptFullName)

If WScript.Arguments.Count > 0 Then
  WaitForExit CLng(WScript.Arguments.Item(0))
End If

latestFolder = NewestVersionFolder(installRoot)
If latestFolder <> "" Then
  shell.Run Quote(fileSystem.BuildPath(latestFolder, APP_EXE)), 1, False
End If

Function NewestVersionFolder(root)
  Dim folder, candidate
  candidate = ""

  For Each folder In fileSystem.GetFolder(root).SubFolders
    If IsVersion(folder.Name) Then
      If fileSystem.FileExists(fileSystem.BuildPath(folder.Path, APP_EXE)) Then
        If candidate = "" Then
          candidate = folder.Path
        ElseIf CompareVersions(folder.Name, fileSystem.GetFileName(candidate)) > 0 Then
          candidate = folder.Path
        End If
      End If
    End If
  Next

  NewestVersionFolder = candidate
End Function

Function IsVersion(value)
  Dim parts
  IsVersion = False
  parts = Split(value, ".")

  If UBound(parts) <> 2 Then Exit Function
  If Not IsNumeric(parts(0)) Then Exit Function
  If Not IsNumeric(parts(1)) Then Exit Function
  If Not IsNumeric(parts(2)) Then Exit Function

  IsVersion = True
End Function

Function CompareVersions(left, right)
  Dim leftParts, rightParts, index
  leftParts = Split(left, ".")
  rightParts = Split(right, ".")

  For index = 0 To 2
    If CLng(leftParts(index)) <> CLng(rightParts(index)) Then
      CompareVersions = Sgn(CLng(leftParts(index)) - CLng(rightParts(index)))
      Exit Function
    End If
  Next

  CompareVersions = 0
End Function

' Waits for the retiring overlay to go away before the new one starts.
'
' Every WMI failure here falls back to a fixed grace period instead of stopping
' the script: an update that cannot poll is still an update, and leaving the
' user with no overlay -- and a Windows Script Host error dialog -- is worse
' than starting a moment early.
Sub WaitForExit(processId)
  Const POLL_MS = 250
  Const TIMEOUT_MS = 30000
  Const GRACE_MS = 3000

  Dim cimv2, processes, waited

  On Error Resume Next

  ' VBScript has no backslash escape, so this moniker must be written exactly
  ' as WMI reads it. A doubled separator leaves an empty namespace segment and
  ' fails with 0x80041021 (WBEM_E_INVALID_SYNTAX).
  Set cimv2 = GetObject("winmgmts:\\.\root\cimv2")
  If Err.Number <> 0 Then
    Err.Clear
    On Error GoTo 0
    WScript.Sleep GRACE_MS
    Exit Sub
  End If

  waited = 0
  Do While waited < TIMEOUT_MS
    Set processes = cimv2.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE ProcessId = " & processId)
    If Err.Number <> 0 Then
      Err.Clear
      On Error GoTo 0
      WScript.Sleep GRACE_MS
      Exit Sub
    End If

    If processes.Count = 0 Then Exit Sub

    WScript.Sleep POLL_MS
    waited = waited + POLL_MS
  Loop

  On Error GoTo 0
End Sub

Function Quote(value)
  Quote = Chr(34) & value & Chr(34)
End Function
