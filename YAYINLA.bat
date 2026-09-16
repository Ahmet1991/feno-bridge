@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

set "BUN_EXE="
set "TEMP_BUN="
where bun.exe >nul 2>nul && set "BUN_EXE=bun.exe"

if not defined BUN_EXE if exist "%LOCALAPPDATA%\Programs\Feno Bridge\resources\runtime\runtime\bun.exe" (
  set "BUN_EXE=%LOCALAPPDATA%\Programs\Feno Bridge\resources\runtime\runtime\bun.exe"
)

if not defined BUN_EXE if exist "%LOCALAPPDATA%\Programs\Codex Web GPT\resources\runtime\runtime\bun.exe" (
  set "BUN_EXE=%LOCALAPPDATA%\Programs\Codex Web GPT\resources\runtime\runtime\bun.exe"
)

if not defined BUN_EXE if exist "%~dp0launcher\build\runtime\runtime\bun.exe" (
  set "TEMP_BUN=%TEMP%\feno-release-bun-%RANDOM%-%RANDOM%.exe"
  copy /y "%~dp0launcher\build\runtime\runtime\bun.exe" "!TEMP_BUN!" >nul
  if errorlevel 1 (
    echo Gecici Bun kopyasi olusturulamadi.
    exit /b 1
  )
  set "BUN_EXE=!TEMP_BUN!"
)

if not defined BUN_EXE (
  echo Bun bulunamadi. Feno Bridge veya Bun kurulu olmali.
  pause
  exit /b 1
)

"%BUN_EXE%" run scripts\release-windows.ts %*
set "RESULT=%ERRORLEVEL%"

if defined TEMP_BUN del /q "%TEMP_BUN%" >nul 2>nul

if "%RESULT%"=="0" (
  echo.
  echo Islem tamamlandi.
) else (
  echo.
  echo Islem basarisiz. Yukaridaki hatayi kontrol et.
)

if /I not "%~2"=="--yes" if /I not "%~3"=="--yes" pause
exit /b %RESULT%
