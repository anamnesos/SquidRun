Option Explicit

Dim fso, shell, scriptsDir, uiDir, projectRoot, nodePath, watcherPath, command, index
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptsDir = fso.GetParentFolderName(WScript.ScriptFullName)
uiDir = fso.GetParentFolderName(scriptsDir)
projectRoot = fso.GetParentFolderName(uiDir)
nodePath = "C:\Program Files\nodejs\node.exe"
watcherPath = fso.BuildPath(scriptsDir, "hm-main-e28-restoration-watch.js")
command = Quote(nodePath) & " " & Quote(watcherPath)
For index = 0 To WScript.Arguments.Count - 1
  command = command & " " & Quote(WScript.Arguments(index))
Next
' Receipts are the sole truth channel; do not redirect to an unbounded log.

' WindowStyle 0 is the critical W7 contract: no console flash and no focus steal.
shell.Run command, 0, False

Function Quote(value)
  Quote = """" & Replace(CStr(value), """"", """""""") & """"
End Function
