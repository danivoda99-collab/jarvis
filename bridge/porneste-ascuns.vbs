' Pornește puntea Argus fără fereastră; jurnalul ajunge în bridge.log.
Set shell = CreateObject("WScript.Shell")
folder = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = folder
shell.Run "cmd /c node argus-bridge.mjs >> bridge.log 2>&1", 0, False
