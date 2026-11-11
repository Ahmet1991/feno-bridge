import { expect, test } from "bun:test";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PcAuthorizer } from "../src/pc-control/authorization";
import { createPcJobManager } from "../src/pc-control/jobs";

const execute = promisify(execFile);
const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const windowsTest = process.platform === "win32" ? test : test.skip;
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function until(check: () => boolean, timeout = 8_000) {
  const end = Date.now() + timeout;
  while (!check() && Date.now() < end) await Bun.sleep(50);
  expect(check()).toBe(true);
}

for (const end of ["cancel", "timeout", "wrapper exit", "revoke"] as const) {
  windowsTest(`Windows job object contains a background grandchild after parent exit through ${end}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "pc-terminal-contained-"));
    const policy = new PcAuthorizer();
    policy.setGrantFromLocalApproval({ id: `contained-terminal-${end.replaceAll(" ", "-")}`,
      expiresAt: null, roots: [root], permissions: ["jobs", "terminal.exec"], allowedApps: [] });
    let wrapper: ChildProcess | undefined;
    let workerPid: number | undefined;
    const manager = createPcJobManager({ projectRoot: root, commandSpecs: {},
      terminalTimeoutMs: end === "timeout" ? 8_000 : 20_000, auditCommand() {},
      spawnProcess: (command, args, options) => {
        const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
        wrapper = child;
        return child;
      },
    });
    try {
      const encoded = Buffer.from("Start-Sleep -Seconds 60", "utf16le").toString("base64");
      const marker = join(root, "grandchild.pid").replaceAll("'", "''");
      const startGrandchild = `$child = Start-Process -FilePath '${powershell.replaceAll("'", "''")}' -ArgumentList '-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand','${encoded}' -WindowStyle Hidden -PassThru; [IO.File]::WriteAllText('${marker}', [string]$child.Id)`;
      const encodedParent = Buffer.from(startGrandchild, "utf16le").toString("base64");
      const command = `$parent = Start-Process -FilePath '${powershell.replaceAll("'", "''")}' -ArgumentList '-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand','${encodedParent}' -WindowStyle Hidden -PassThru; $parent.WaitForExit(); [Console]::WriteLine('FENO_CHILD_PID=' + [IO.File]::ReadAllText('${marker}'))`;
      const { jobId } = await manager.startTerminalCommand({ projectRoot: root, command, purpose: "Verify contained background child" }, policy);
      await until(() => {
        const match = /FENO_CHILD_PID=(\d+)/.exec(manager.pcJobLogs(jobId, 0, policy).lines.join("\n"));
        if (match) workerPid = Number(match[1]);
        return workerPid !== undefined;
      });
      await Bun.sleep(500); // The command's immediate PowerShell parent has returned.
      expect(alive(workerPid!)).toBe(true);
      expect(manager.pcJobStatus(jobId, policy).state).toBe("running");
      await expect(manager.startTerminalCommand({ projectRoot: root, command: "Write-Output next", purpose: "Must retain the terminal lease" }, policy))
        .rejects.toThrow("pc_terminal_busy");
      if (end === "cancel") await manager.cancelPcJob(jobId, policy);
      else if (end === "revoke") { policy.revoke(); await manager.revokeAll(); }
      else if (end === "wrapper exit") wrapper!.kill();
      await until(() => !alive(workerPid!), end === "timeout" ? 10_000 : 5_000);
      await until(() => manager.activeJobCount() === 0);
      expect(manager.hasActiveTerminal()).toBe(false);
    } finally {
      await manager.revokeAll();
      if (wrapper?.pid && alive(wrapper.pid)) wrapper.kill();
      if (workerPid && alive(workerPid)) await execute("taskkill.exe", ["/PID", String(workerPid), "/T", "/F"], { windowsHide: true }).catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  }, 25_000);
}

windowsTest("contained terminal preserves command quoting, Unicode, stderr and the command exit code", async () => {
  const root = mkdtempSync(join(tmpdir(), "pc-terminal-output-"));
  const policy = new PcAuthorizer();
  policy.setGrantFromLocalApproval({ id: "contained-terminal-output-grant", expiresAt: null,
    roots: [root], permissions: ["jobs", "terminal.exec"], allowedApps: [] });
  const manager = createPcJobManager({ projectRoot: root, commandSpecs: {}, auditCommand() {} });
  try {
    const { jobId } = await manager.startTerminalCommand({ projectRoot: root,
      command: "[Console]::OutputEncoding = [Text.Encoding]::UTF8; [Console]::WriteLine('Türkçe ''quotes'' $literal'); [Console]::Error.WriteLine('fixture stderr'); exit 7",
      purpose: "Verify command data and output" }, policy);
    await until(() => manager.pcJobStatus(jobId, policy).state !== "running");
    expect(manager.pcJobStatus(jobId, policy)).toEqual({ state: "failed", exitCode: 7 });
    const lines = manager.pcJobLogs(jobId, 0, policy).lines;
    expect(lines).toContain("Türkçe 'quotes' $literal");
    expect(lines).toContain("fixture stderr");
  } finally { await manager.revokeAll(); rmSync(root, { recursive: true, force: true }); }
}, 15_000);

for (const [name, command, expected] of [
  ["last native program", `& '${process.execPath.replaceAll("'", "''")}' -e 'process.exit(17)'`, 17],
  ["nested PowerShell", `& '${powershell.replaceAll("'", "''")}' -NoProfile -Command 'exit 17'`, 17],
  ["successful final statement", `& '${process.execPath.replaceAll("'", "''")}' -e 'process.exit(17)'; Write-Output recovered`, 0],
] as const) {
  windowsTest(`contained terminal preserves ${name} status without explicit outer exit`, async () => {
    const directory=mkdtempSync(join(tmpdir(),"pc-exit-status-"));
    const policy=new PcAuthorizer();
    policy.setGrantFromLocalApproval({id:"terminal-exit-status-grant",expiresAt:null,roots:[directory],permissions:["jobs","terminal.exec"],allowedApps:[]});
    const manager=createPcJobManager({projectRoot:directory,commandSpecs:{},auditCommand(){}});
    try {
      const {jobId}=await manager.startTerminalCommand({projectRoot:directory,command,purpose:"Verify last command exit status"},policy);
      await until(()=>manager.pcJobStatus(jobId,policy).state!=="running");
      expect(manager.pcJobStatus(jobId,policy)).toEqual({state:expected===0?"succeeded":"failed",exitCode:expected});
    } finally {await manager.revokeAll();rmSync(directory,{recursive:true,force:true});}
  },15_000);
}
