@echo off
setlocal
cd /d "%~dp0"
echo.
echo   正在桌面创建「PDF 摘录白板」快捷方式...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ws = New-Object -ComObject WScript.Shell;" ^
  "$lnk = $ws.CreateShortcut([Environment]::GetFolderPath('Desktop') + '\PDF 摘录白板.lnk');" ^
  "$lnk.TargetPath = '%~dp0启动 PDF 摘录白板.cmd';" ^
  "$lnk.WorkingDirectory = '%~dp0';" ^
  "$lnk.IconLocation = '%%SystemRoot%%\System32\imageres.dll,68';" ^
  "$lnk.Description = 'PDF 摘录白板 - 左PDF右白板';" ^
  "$lnk.WindowStyle = 7;" ^
  "$lnk.Save();" ^
  "Write-Host '  完成：桌面上的「PDF 摘录白板」'"
echo.
echo   提示：以后也可以直接把 PDF 文件拖到这个桌面图标上，启动后自动打开它。
echo.
pause
