' Silent login launcher for Buddy (handles paths with spaces).
Option Explicit

Dim shell, fso, root, electron, distIndex, buildCmd
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
electron = root & "\node_modules\electron\dist\electron.exe"
distIndex = root & "\dist\index.html"

If Not fso.FileExists(electron) Then
  WScript.Quit 1
End If

shell.CurrentDirectory = root

If Not fso.FileExists(distIndex) Then
  buildCmd = "cmd /c npm run build"
  shell.Run buildCmd, 0, True
End If

If Not fso.FileExists(distIndex) Then
  WScript.Quit 1
End If

shell.Run """" & electron & """ """ & root & """", 0, False
