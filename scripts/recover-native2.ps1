[CmdletBinding()]
param(
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

function Write-Step([string]$Text) {
  Write-Output $Text
}

function Get-InstalledBridgeRuntime {
  $bridgeHome = Join-Path $env:USERPROFILE ".codex-chatgpt-web"
  $versions = Join-Path $bridgeHome "versions"
  if (-not (Test-Path -LiteralPath $versions)) {
    throw "Codex Web GPT versions directory was not found: $versions"
  }

  $candidate = Get-ChildItem -LiteralPath $versions -Directory |
    Sort-Object LastWriteTime -Descending |
    Where-Object {
      (Test-Path -LiteralPath (Join-Path $_.FullName "runtime\bun.exe")) -and
      (Test-Path -LiteralPath (Join-Path $_.FullName "app\cli.js"))
    } |
    Select-Object -First 1

  if (-not $candidate) {
    throw "No complete Codex Web GPT runtime installation was found."
  }

  return [pscustomobject]@{
    Home = $bridgeHome
    Bun = Join-Path $candidate.FullName "runtime\bun.exe"
    Cli = Join-Path $candidate.FullName "app\cli.js"
  }
}

function Invoke-BridgeCli($runtime, [string[]]$Arguments) {
  $output = & $runtime.Bun $runtime.Cli --home $runtime.Home @Arguments 2>&1 | Out-String
  return [pscustomobject]@{
    ExitCode = $LASTEXITCODE
    Output = $output.Trim()
  }
}

function Invoke-Doctor($runtime) {
  $result = Invoke-BridgeCli $runtime @("doctor", "--json")
  if ($result.ExitCode -eq 0) {
    try {
      $report = $result.Output | ConvertFrom-Json
      if ($report.ok -eq $true) {
        return [pscustomobject]@{ Healthy = $true; Output = $result.Output }
      }
    } catch {}
  }
  return [pscustomobject]@{ Healthy = $false; Output = $result.Output }
}

function Set-StandardContextPreference {
  $targets = @(
    (Join-Path $env:USERPROFILE ".codex-chatgpt-web\config.json"),
    (Join-Path $env:APPDATA "Codex Web GPT\launcher-state.json")
  )
  $changed = $false

  foreach ($path in $targets) {
    if (-not (Test-Path -LiteralPath $path)) {
      continue
    }

    $json = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    $property = $json.PSObject.Properties["experimentalBiggerContext"]
    if ($property -and $property.Value -eq $false) {
      continue
    }

    if ($property) {
      $json.experimentalBiggerContext = $false
    } else {
      $json | Add-Member -NotePropertyName "experimentalBiggerContext" -NotePropertyValue $false
    }

    $serialized = $json | ConvertTo-Json -Depth 100
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($path, $serialized, $utf8NoBom)
    $changed = $true
  }

  return $changed
}

function Restart-Launcher {
  $launcher = Join-Path $env:LOCALAPPDATA "Programs\Codex Web GPT\Codex Web GPT.exe"
  if (-not (Test-Path -LiteralPath $launcher)) {
    throw "Codex Web GPT launcher was not found: $launcher"
  }

  $main = Get-CimInstance Win32_Process |
    Where-Object {
      $_.Name -eq "Codex Web GPT.exe" -and
      $_.ExecutablePath -eq $launcher -and
      $_.CommandLine -match 'Codex Web GPT\.exe"?\s*$'
    } |
    Select-Object -First 1

  if ($main) {
    & taskkill.exe /PID $main.ProcessId /T /F *> $null
    Start-Sleep -Milliseconds 800
  }

  Start-Process -FilePath $launcher -WindowStyle Hidden | Out-Null

  $descriptor = Join-Path $env:USERPROFILE ".codex-chatgpt-web\runtime\launcher-browser.json"
  $deadline = (Get-Date).AddSeconds(20)
  do {
    Start-Sleep -Milliseconds 500
    if (Test-Path -LiteralPath $descriptor) {
      try {
        $browser = Get-Content -LiteralPath $descriptor -Raw | ConvertFrom-Json
        if ($browser.pid -and (Get-Process -Id $browser.pid -ErrorAction SilentlyContinue)) {
          return
        }
      } catch {}
    }
  } while ((Get-Date) -lt $deadline)

  throw "Codex Web GPT launcher did not become ready within 20 seconds."
}

Write-Step "1. Cancel active Codex Web turns"
Write-Step "2. Force Standard Context in bridge and launcher state"
Write-Step "3. Restart Codex Web GPT if context preference changed"
Write-Step "4. Run doctor"
Write-Step "5. Restart Codex Web GPT only if doctor still fails"
Write-Step "6. Run doctor again and report final health"

if ($DryRun) {
  Write-Output "DRY_RUN_OK"
  exit 0
}

try {
  $runtime = Get-InstalledBridgeRuntime

  $cancel = Invoke-BridgeCli $runtime @("service", "cancel-turns")
  if ($cancel.ExitCode -ne 0) {
    Write-Warning "Active-turn cancellation did not complete cleanly; continuing with health check."
  }

  $contextChanged = Set-StandardContextPreference
  if ($contextChanged) {
    Write-Output "Standard Context preference corrected. Restarting Codex Web GPT so the runtime reloads it..."
    Restart-Launcher
    Start-Sleep -Seconds 2
  }

  $doctor = Invoke-Doctor $runtime
  if ($doctor.Healthy) {
    Write-Output "Native2 is healthy; launcher restart was not needed."
    exit 0
  }

  Write-Output "Doctor still reports an unhealthy browser path. Restarting only Codex Web GPT..."
  Restart-Launcher
  Start-Sleep -Seconds 2

  $finalDoctor = Invoke-Doctor $runtime
  if (-not $finalDoctor.Healthy) {
    Write-Error "Native2 recovery finished but doctor is still unhealthy.`n$($finalDoctor.Output)"
    exit 1
  }

  Write-Output "Native2 recovery completed successfully. No PC restart or reinstall was required."
  exit 0
} catch {
  Write-Error $_
  exit 1
}
