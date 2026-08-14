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

Sub WaitForExit(processId)
  Dim processes
  Do
    Set processes = GetObject("winmgmts:root\\cimv2").ExecQuery("SELECT ProcessId FROM Win32_Process WHERE ProcessId = " & processId)
    If processes.Count = 0 Then Exit Do
    WScript.Sleep 250
  Loop
End Sub

Function Quote(value)
  Quote = Chr(34) & value & Chr(34)
End Function
