@echo off
setlocal

set "SCRIPT=%~dp0recover-native2.ps1"
set "ARGS=%*"

if /I "%~1"=="--dry-run" set "ARGS=-DryRun"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %ARGS%
exit /b %ERRORLEVEL%
