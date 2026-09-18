Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
billingDir = fso.GetParentFolderName(WScript.ScriptFullName)

Set oExec = WshShell.Exec("cmd.exe /c netstat -aon | findstr :3001 | findstr LISTENING")
strOut = oExec.StdOut.ReadAll()

If InStr(strOut, "3001") = 0 Then
    cmdToRun = "cmd.exe /c cd /d """ & billingDir & """ && set NO_AUTO_OPEN=true&& set DAEMON=true&& node whatsapp-bot.js"
    WshShell.Run cmdToRun, 0, False
End If
