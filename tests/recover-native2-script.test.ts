import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Native2 runtime discovery works without overwriting PowerShell HOME", async () => {
  if (process.platform !== "win32") return;
  const script = join(import.meta.dir, "..", "scripts", "recover-native2.ps1");
  const command = `
    $tokens = $null; $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile('${script.replaceAll("'", "''")}', [ref]$tokens, [ref]$parseErrors)
    $definition = $ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-InstalledBridgeRuntime'}, $true)
    Invoke-Expression $definition.Extent.Text
    $ErrorActionPreference = 'Stop'
    $runtime = Get-InstalledBridgeRuntime
    if (-not (Test-Path -LiteralPath $runtime.Bun)) { throw 'Runtime missing' }
    Write-Output 'RUNTIME_DISCOVERY_OK'
  `;
  const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-Command", command], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  expect(exitCode, stderr).toBe(0);
  expect(stdout).toContain("RUNTIME_DISCOVERY_OK");
});

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
});

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
});

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
});
