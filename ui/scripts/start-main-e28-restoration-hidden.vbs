Option Explicit

Dim shell, nodePath, command, index
Set shell = CreateObject("WScript.Shell")
nodePath = "C:\Program Files\nodejs\node.exe"
command = Quote(nodePath)
For index = 0 To WScript.Arguments.Count - 1
  command = command & " " & Quote(WScript.Arguments(index))
Next
' Receipts are the sole truth channel; do not redirect to an unbounded log.

' WindowStyle 0 is the critical W7 contract: no console flash and no focus steal.
shell.Run command, 0, False

Function Quote(value)
  Quote = """" & Replace(CStr(value), """"", """""""") & """"
End Function
