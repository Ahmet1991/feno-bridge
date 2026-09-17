$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if ($PSVersionTable.PSVersion.Major -lt 6) {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
}

function Invoke-WithRetry {
  param(
    [Parameter(Mandatory = $true)][scriptblock]$Operation,
    [Parameter(Mandatory = $true)][string]$Label
  )
  for ($Attempt = 1; $Attempt -le 3; $Attempt++) {
    try {
      return & $Operation
    } catch {
      if ($Attempt -eq 3) {
        throw "$Label failed after $Attempt attempts: $($_.Exception.Message)"
      }
      Start-Sleep -Seconds (2 * $Attempt)
    }
  }
}

function Test-IsFullyQualifiedWindowsPath {
  param([AllowEmptyString()][string]$Path)
  return $Path -match '^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$))'
}

$Repository = if ($env:CODEX_WEB_GPT_REPOSITORY) { $env:CODEX_WEB_GPT_REPOSITORY } else { "Ahmet1991/feno-bridge" }
if ($Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
  throw "Invalid GitHub repository: $Repository"
}
$Version = $env:CODEX_WEB_GPT_VERSION
if (-not $Version) {
  $Version = Invoke-WithRetry -Label "Resolving the latest public release" -Operation {
    $Release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repository/releases/latest" `
      -Headers @{ "User-Agent" = "Feno-Bridge-Installer"; "Accept" = "application/vnd.github+json" } `
      -ErrorAction Stop
    $Release.tag_name
  }
}
if ($Version -and $Version.StartsWith("v")) { $Version = $Version.Substring(1) }
if (-not $Version) { throw "Could not resolve the latest Feno Bridge release" }
if ($Version -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw "Invalid release version: $Version" }

if (-not [Environment]::Is64BitOperatingSystem) {
  throw "The packaged Windows launcher requires 64-bit Windows"
}
$Arch = "x64"

$Asset = "feno-bridge-$Version-win-$Arch.exe"
$DownloadBase = "https://github.com/$Repository/releases/download/v$Version"
$Temp = Join-Path ([System.IO.Path]::GetTempPath()) "codex-web-gpt-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $Temp | Out-Null
try {
  if (Get-Process -Name "Feno Bridge", "Codex Web GPT" -ErrorAction SilentlyContinue) {
    throw "Quit Feno Bridge before updating it"
  }
  $Installer = Join-Path $Temp $Asset
  $Checksums = Join-Path $Temp "checksums.txt"
  $null = Invoke-WithRetry -Label "Downloading $Asset" -Operation {
    Remove-Item $Installer -Force -ErrorAction SilentlyContinue
    Invoke-WebRequest -Uri "$DownloadBase/$Asset" -OutFile $Installer -UseBasicParsing -ErrorAction Stop
  }
  $null = Invoke-WithRetry -Label "Downloading checksums.txt" -Operation {
    Remove-Item $Checksums -Force -ErrorAction SilentlyContinue
    Invoke-WebRequest -Uri "$DownloadBase/checksums.txt" -OutFile $Checksums -UseBasicParsing -ErrorAction Stop
  }
  $ExpectedLine = Get-Content $Checksums | Where-Object { $_ -match "\s$([regex]::Escape($Asset))$" } | Select-Object -First 1
  if (-not $ExpectedLine) { throw "checksums.txt has no entry for $Asset" }
  $Expected = ($ExpectedLine -split "\s+")[0].ToLowerInvariant()
  $Actual = (Get-FileHash -Algorithm SHA256 $Installer).Hash.ToLowerInvariant()
  if ($Actual -ne $Expected) { throw "SHA-256 verification failed for $Asset" }
  $Process = Start-Process -FilePath $Installer -ArgumentList "/S", "/currentuser" -Wait -PassThru
  if ($Process.ExitCode -ne 0) { throw "Installer exited with code $($Process.ExitCode)" }
  $InstallRegistry = "HKCU:\Software\d1a6026a-6210-588e-9a2b-da3936f94e02"
  $InstallLocation = [string](Get-ItemPropertyValue -LiteralPath $InstallRegistry -Name "InstallLocation")
  if (-not (Test-IsFullyQualifiedWindowsPath $InstallLocation)) {
    throw "Installer recorded an invalid InstallLocation: $InstallLocation"
  }
  $Executable = Join-Path $InstallLocation "Feno Bridge.exe"
  if (-not (Test-Path $Executable)) { throw "Installed launcher was not found at $Executable" }
  Start-Process $Executable
  Write-Host "Installed $Executable"
} finally {
  Remove-Item -Recurse -Force $Temp -ErrorAction SilentlyContinue
}
