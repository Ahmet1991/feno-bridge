import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every test below starts a PowerShell or cmd process, and a cold PowerShell start on a loaded
// runner costs far more than Bun's 5s default per-test budget: the dry-run test timed out at
// exactly 5000ms on an ubuntu runner while the same run takes ~400ms locally once PowerShell is
// warm. The budget has to cover process startup, not the assertions, which finish in microseconds.
const SHELL_TEST_TIMEOUT_MS = 60_000;

// Discovery is exercised against a staged USERPROFILE rather than whatever happens to be
// installed on the machine. Reading a real installation made this assert a developer-machine
// precondition, so it failed on every CI runner, where no bridge is installed.
test("Native2 runtime discovery works without overwriting PowerShell HOME", async () => {
  if (process.platform !== "win32") return;
  const script = join(import.meta.dir, "..", "scripts", "recover-native2.ps1");
  const root = mkdtempSync(join(tmpdir(), "native2-runtime-discovery-"));
  const command = `
    $tokens = $null; $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile('${script.replaceAll("'", "''")}', [ref]$tokens, [ref]$parseErrors)
    $definition = $ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-InstalledBridgeRuntime'}, $true)
    Invoke-Expression $definition.Extent.Text
    $ErrorActionPreference = 'Stop'

    $root = '${root.replaceAll("'", "''")}'
    $versions = Join-Path (Join-Path $root '.codex-chatgpt-web') 'versions'
    # A half-installed version must never be chosen, whatever its timestamp says.
    $partial = Join-Path (Join-Path $versions '4.0.0') 'runtime'
    New-Item -ItemType Directory -Path $partial -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $partial 'bun.exe') -Value 'stub'
    $completeRuntime = Join-Path (Join-Path $versions '5.0.4') 'runtime'
    $completeApp = Join-Path (Join-Path $versions '5.0.4') 'app'
    New-Item -ItemType Directory -Path $completeRuntime -Force | Out-Null
    New-Item -ItemType Directory -Path $completeApp -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $completeRuntime 'bun.exe') -Value 'stub'
    Set-Content -LiteralPath (Join-Path $completeApp 'cli.js') -Value 'stub'

    $env:USERPROFILE = $root
    $homeBefore = $HOME
    $runtime = Get-InstalledBridgeRuntime
    if ($HOME -ne $homeBefore) { throw "PowerShell HOME was overwritten: $homeBefore -> $HOME" }
    if (-not (Test-Path -LiteralPath $runtime.Bun)) { throw 'Runtime missing' }
    if (-not (Test-Path -LiteralPath $runtime.Cli)) { throw 'CLI missing' }
    if ($runtime.Bun -notlike '*5.0.4*') { throw "Incomplete installation was selected: $($runtime.Bun)" }
    Write-Output 'RUNTIME_DISCOVERY_OK'
  `;
  try {
    const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-Command", command], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    expect(exitCode, stderr).toBe(0);
    expect(stdout).toContain("RUNTIME_DISCOVERY_OK");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, SHELL_TEST_TIMEOUT_MS);

test("Native2 recovery dry-run describes the safe recovery sequence", async () => {
  const script = join(import.meta.dir, "..", "scripts", "recover-native2.ps1");
  const shell = process.platform === "win32" ? "powershell.exe" : "pwsh";
  const proc = Bun.spawn([shell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-DryRun"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  expect(exitCode, stderr).toBe(0);
  expect(stdout).toContain("1. Cancel active Codex Web turns");
  expect(stdout).toContain("2. Force Standard Context in bridge and launcher state");
  expect(stdout).toContain("3. Restart Codex Web GPT if context preference changed");
  expect(stdout).toContain("4. Run doctor");
  expect(stdout).toContain("5. Restart Codex Web GPT only if doctor still fails");
  expect(stdout).toContain("6. Run doctor again and report final health");
  expect(stdout).toContain("7. Report every check that cannot be proven from this machine");
}, SHELL_TEST_TIMEOUT_MS);

test("Native2 recovery synchronizes Standard Context across bridge and launcher state", async () => {
  if (process.platform !== "win32") return;
  const script = join(import.meta.dir, "..", "scripts", "recover-native2.ps1");
  const root = mkdtempSync(join(tmpdir(), "native2-standard-context-"));
  const userProfile = join(root, "user");
  const appData = join(root, "roaming");
  const bridgeDir = join(userProfile, ".codex-chatgpt-web");
  const launcherDir = join(appData, "Codex Web GPT");
  mkdirSync(bridgeDir, { recursive: true });
  mkdirSync(launcherDir, { recursive: true });
  writeFileSync(join(bridgeDir, "config.json"), JSON.stringify({ version: 3, experimentalBiggerContext: true }));
  writeFileSync(join(launcherDir, "launcher-state.json"), JSON.stringify({ experimentalBiggerContext: true }));

  try {
    const command = `
      $tokens = $null; $parseErrors = $null
      $ast = [System.Management.Automation.Language.Parser]::ParseFile('${script.replaceAll("'", "''")}', [ref]$tokens, [ref]$parseErrors)
      $definition = $ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Set-StandardContextPreference'}, $true)
      if (-not $definition) { throw 'Set-StandardContextPreference function missing' }
      Invoke-Expression $definition.Extent.Text
      $env:USERPROFILE = '${userProfile.replaceAll("'", "''")}'
      $env:APPDATA = '${appData.replaceAll("'", "''")}'
      Set-StandardContextPreference
    `;
    const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-Command", command], { stdout: "pipe", stderr: "pipe" });
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(exitCode, stderr).toBe(0);

    const bridge = JSON.parse(readFileSync(join(bridgeDir, "config.json"), "utf8"));
    const launcher = JSON.parse(readFileSync(join(launcherDir, "launcher-state.json"), "utf8"));
    expect(bridge.experimentalBiggerContext).toBe(false);
    expect(launcher.experimentalBiggerContext).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, SHELL_TEST_TIMEOUT_MS);

test("Native2 recovery command wrapper supports a one-command dry-run", async () => {
  if (process.platform !== "win32") return;
  const wrapper = join(import.meta.dir, "..", "scripts", "recover-native2.cmd");
  const proc = Bun.spawn([process.env.COMSPEC || "cmd.exe", "/d", "/c", wrapper, "--dry-run"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  expect(exitCode, stderr).toBe(0);
  expect(stdout).toContain("DRY_RUN_OK");
}, SHELL_TEST_TIMEOUT_MS);

// Runs on every platform: the regression this guards is a claim in the script text, and the
// Windows-only tests above cannot catch it on a Linux or macOS CI leg.
test("Native2 recovery never reports health that doctor did not prove", () => {
  const script = readFileSync(join(import.meta.dir, "..", "scripts", "recover-native2.ps1"), "utf8");

  // A passing doctor covers local checks only; the ChatGPT-side connector is never proven by it.
  expect(script).not.toContain("Native2 is healthy");
  expect(script).toContain("Native2 passed every local check");
  expect(script).toContain("Native2 local recovery completed successfully");
});

test("Native2 recovery surfaces the connector checks doctor cannot prove", () => {
  const script = readFileSync(join(import.meta.dir, "..", "scripts", "recover-native2.ps1"), "utf8");

  expect(script).toContain("function Get-UnprovenChecks");
  expect(script).toContain("function Write-UnprovenConnectorGuidance");
  // Read defensively: an older bundled runtime emits a report with no unproven field.
  expect(script).toContain('$report.PSObject.Properties["unproven"]');
  // The cloud-side remedy the script now names instead of declaring victory.
  expect(script).toContain("Authentication set to None");
  expect(script).toContain("Allow all actions");
  expect(script).toContain("under a new name instead of renaming or refreshing the rejected one");
});
