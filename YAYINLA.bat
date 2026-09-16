@echo off
setlocal
cd /d "%~dp0"

set "BUN_EXE="
where bun.exe >nul 2>nul && set "BUN_EXE=bun.exe"

if not defined BUN_EXE if exist "%~dp0launcher\build\runtime\runtime\bun.exe" (
  set "BUN_EXE=%~dp0launcher\build\runtime\runtime\bun.exe"
)

if not defined BUN_EXE if exist "%LOCALAPPDATA%\Programs\Feno Bridge\resources\runtime\runtime\bun.exe" (
  set "BUN_EXE=%LOCALAPPDATA%\Programs\Feno Bridge\resources\runtime\runtime\bun.exe"
)

if not defined BUN_EXE if exist "%LOCALAPPDATA%\Programs\Codex Web GPT\resources\runtime\runtime\bun.exe" (
  set "BUN_EXE=%LOCALAPPDATA%\Programs\Codex Web GPT\resources\runtime\runtime\bun.exe"
)

if not defined BUN_EXE (
  echo Bun bulunamadi. Feno Bridge veya Bun kurulu olmali.
  pause
  exit /b 1
)

"%BUN_EXE%" run scripts\release-windows.ts %*
set "RESULT=%ERRORLEVEL%"

if "%RESULT%"=="0" (
  echo.
  echo Islem tamamlandi.
) else (
  echo.
  echo Islem basarisiz. Yukaridaki hatayi kontrol et.
)

if /I not "%~2"=="--yes" if /I not "%~3"=="--yes" pause
exit /b %RESULT%
