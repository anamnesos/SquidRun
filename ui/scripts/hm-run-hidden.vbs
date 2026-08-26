Option Explicit

Dim arguments, shell, command, index, exitCode
Set arguments = WScript.Arguments

If arguments.Count < 1 Then WScript.Quit 87

Set shell = CreateObject("WScript.Shell")
command = Quote(arguments(0))
For index = 1 To arguments.Count - 1
  command = command & " " & Quote(arguments(index))
Next

' wscript.exe has no console of its own. WindowStyle 0 keeps the entire child
' tree hidden, WaitOnReturn preserves the real exit code for Task Scheduler.
exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode

Function Quote(value)
  If InStr(CStr(value), Chr(34)) > 0 Then WScript.Quit 87
  Quote = Chr(34) & CStr(value) & Chr(34)
End Function
