import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { PcAuthorizer } from "../src/pc-control/authorization";
import { createPcJobManager, inferPcCommandSpecs } from "../src/pc-control/jobs";

const root = mkdtempSync(join(tmpdir(), "pc-job-root-"));
const authorizer = new PcAuthorizer();
authorizer.setGrantFromLocalApproval({
  id: "job-local-grant-first", expiresAt: Date.now() + 60_000,
  roots: [root], permissions: ["jobs"], allowedApps: [],
});

function fakeChild() {
  const emitter = new EventEmitter() as ChildProcessByStdio<null, Readable, Readable>;
  (emitter as any).stdout = new PassThrough();
  (emitter as any).stderr = new PassThrough();
  (emitter as any).pid = 12345;
  (emitter as any).kill = () => { emitter.emit("close", null); return true; };
  return emitter;
}

test("jobs accept only configured commands, and never take a shell string from MCP", async () => {
  const spawned: { command: string; args: string[]; cwd: string }[] = [];
  const manager = createPcJobManager({
    projectRoot: root,
    commandSpecs: { "unit-tests": { command: "bun", args: ["test", "./tests"], usesEmulator: false } },
    spawnProcess: (command, args, opts) => {
      spawned.push({ command, args, cwd: String(opts.cwd) });
      return fakeChild();
    },
  });
  await expect(manager.startPcJob({ kind: "arbitrary-shell" as any, projectRoot: root }, authorizer)).rejects.toThrow("pc_access_denied");
  await expect(manager.startPcJob({ kind: "unit-tests", projectRoot: join(root, "..") }, authorizer)).rejects.toThrow("pc_access_denied");
  const result = await manager.startPcJob({ kind: "unit-tests", projectRoot: root }, authorizer);
  expect(typeof result.jobId).toBe("string");
  expect(manager.pcJobStatus(result.jobId, authorizer).state).toBe("running");
  expect(spawned).toEqual([{ command: "bun", args: ["test", "./tests"], cwd: root }]);
});

test("long jobs immediately return an ID, redact logs, and can cancel their process tree", async () => {
  const child = fakeChild();
  let killedPid: number | undefined;
  const manager = createPcJobManager({
    projectRoot: root,
    commandSpecs: { "android-build": { command: "gradlew.bat", args: ["assembleDebug"], usesEmulator: true } },
    spawnProcess: () => child,
    killTree: async pid => { killedPid = pid; child.emit("close", null); },
  });
  const before = Date.now();
  const { jobId } = await manager.startPcJob({ kind: "android-build", projectRoot: root }, authorizer);
  expect(Date.now() - before).toBeLessThan(500);
  (child.stdout as PassThrough).write("step 1: token=super-secret\nAuthorization: Bearer token-secret\n");
  const logs = manager.pcJobLogs(jobId, 0, authorizer);
  expect(logs.lines.join("\n")).toContain("[REDACTED]");
  expect(logs.lines.join("\n")).not.toContain("super-secret");
  expect(logs.lines.join("\n")).not.toContain("token-secret");
  await manager.cancelPcJob(jobId, authorizer);
  expect(killedPid).toBe(12345);
  expect(manager.pcJobStatus(jobId, authorizer).state).toBe("cancelled");
});

test("two jobs never own the same emulator and released leases can be reused", async () => {
  const children: ReturnType<typeof fakeChild>[] = [];
  const manager = createPcJobManager({
    projectRoot: root,
    commandSpecs: {
      "android-build": { command: "gradlew.bat", args: ["assembleDebug"], usesEmulator: true },
      "playback-smoke": { command: "bun", args: ["run", "smoke"], usesEmulator: true },
    },
    spawnProcess: () => { const child = fakeChild(); children.push(child); return child; },
  });
  await manager.startPcJob({ kind: "android-build", projectRoot: root }, authorizer);
  await expect(manager.startPcJob({ kind: "playback-smoke", projectRoot: root }, authorizer)).rejects.toThrow("pc_access_denied");
  children[0]?.emit("close", 0);
  expect((await manager.startPcJob({ kind: "playback-smoke", projectRoot: root }, authorizer)).jobId).toBeTruthy();
});

test("job access is denied after revocation even for status and logs", async () => {
  const local = new PcAuthorizer();
  local.setGrantFromLocalApproval({ id: "job-local-grant-second", expiresAt: Date.now() + 60_000, roots: [root], permissions: ["jobs"], allowedApps: [] });
  const manager = createPcJobManager({ projectRoot: root, commandSpecs: {}, spawnProcess: () => fakeChild() });
  local.revoke();
  expect(() => manager.pcJobStatus("unknown", local)).toThrow("pc_access_denied");
  expect(() => manager.pcJobLogs("unknown", 0, local)).toThrow("pc_access_denied");
});

test("local command catalog is inferred only from existing project scripts and wrapper files", () => {
  const project = mkdtempSync(join(tmpdir(), "pc-catalog-"));
  writeFileSync(join(project, "package.json"), JSON.stringify({ scripts: {
    typecheck: "tsc --noEmit", test: "bun test", "playback-smoke": "bun test ./smoke",
  } }));
  mkdirSync(join(project, "android"));
  writeFileSync(join(project, "android", "gradlew.bat"), "echo fixture");
  const specs = inferPcCommandSpecs(project, "win32");
  expect(specs.typecheck?.command).toBe(process.execPath);
  expect(specs["unit-tests"]?.args).toEqual(["run", "test"]);
  expect(specs["android-build"]?.usesEmulator).toBe(true);
  expect(specs["playback-smoke"]?.args).toEqual(["run", "playback-smoke"]);
  expect(inferPcCommandSpecs(root, "win32")).toEqual({});
});

test("no more than four local jobs can consume the PC concurrently", async () => {
  const manager = createPcJobManager({
    projectRoot: root,
    commandSpecs: { typecheck: { command: "bun", args: ["run", "typecheck"], usesEmulator: false } },
    spawnProcess: () => fakeChild(),
  });
  for (let i = 0; i < 4; i++) {
    expect((await manager.startPcJob({ kind: "typecheck", projectRoot: root }, authorizer)).jobId).toBeTruthy();
  }
  await expect(manager.startPcJob({ kind: "typecheck", projectRoot: root }, authorizer)).rejects.toThrow("pc_access_denied");
});

test("advanced terminal requires its separate local permission and uses a fixed noninteractive executable", async () => {
  const local = new PcAuthorizer();
  local.setGrantFromLocalApproval({ id: "terminal-local-approval", expiresAt: Date.now() + 60_000,
    roots: [root], permissions: ["jobs", "terminal.exec"], allowedApps: [] });
  const spawned: { command: string; args: string[]; cwd: string }[] = [];
  const audited: any[] = [];
  const manager = createPcJobManager({ projectRoot: root, commandSpecs: {}, platform: "win32",
    auditCommand: item => audited.push(item),
    spawnProcess: (command, args, options) => {
      spawned.push({ command, args, cwd: String(options.cwd) });
      return fakeChild();
    },
  });
  const { jobId } = await manager.startTerminalCommand({ projectRoot: root, command: "git status", purpose: "Inspect changes" }, local);
  expect(manager.pcJobStatus(jobId, local).state).toBe("running");
  expect(spawned).toHaveLength(1);
  expect(spawned[0]!.command.toLowerCase()).toEndWith("\\powershell.exe");
  expect(spawned[0]!.args).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "git status"]);
  expect(spawned[0]!.cwd).toBe(root);
  expect(audited).toHaveLength(1);
  expect(audited[0].purpose).toBe("Inspect changes");
  expect(audited[0].commandHash).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(audited)).not.toContain("git status");
  await expect(manager.startTerminalCommand({ projectRoot: root, command: "dir", purpose: "List" }, local))
    .rejects.toThrow("pc_access_denied");
  await expect(manager.startTerminalCommand({ projectRoot: join(root, ".."), command: "dir", purpose: "List" }, local))
    .rejects.toThrow("pc_access_denied");
});

test("advanced terminal cannot reuse an ordinary jobs grant", async () => {
  const manager = createPcJobManager({ projectRoot: root, commandSpecs: {}, platform: "win32", spawnProcess: () => fakeChild() });
  await expect(manager.startTerminalCommand({ projectRoot: root, command: "Write-Host hello", purpose: "Test" }, authorizer))
    .rejects.toThrow("pc_access_denied");
});

test("terminal command is denied before spawning when local audit storage fails", async () => {
  const local = new PcAuthorizer();
  local.setGrantFromLocalApproval({ id: "terminal-audit-approval", expiresAt: Date.now() + 60_000,
    roots: [root], permissions: ["jobs", "terminal.exec"], allowedApps: [] });
  let spawned = false;
  const manager = createPcJobManager({ projectRoot: root, commandSpecs: {}, platform: "win32",
    auditCommand: () => { throw new Error("disk full"); },
    spawnProcess: () => { spawned = true; return fakeChild(); },
  });
  await expect(manager.startTerminalCommand({ projectRoot: root, command: "echo hello", purpose: "Test audit" }, local))
    .rejects.toThrow("pc_access_denied");
  expect(spawned).toBe(false);
});

test("a terminal command is terminated after its bounded lifetime", async () => {
  const local = new PcAuthorizer();
  local.setGrantFromLocalApproval({ id: "terminal-timeout-approval", expiresAt: Date.now() + 60_000,
    roots: [root], permissions: ["jobs", "terminal.exec"], allowedApps: [] });
  const child = fakeChild();
  let killedPid: number | undefined;
  const manager = createPcJobManager({ projectRoot: root, commandSpecs: {}, platform: "win32", terminalTimeoutMs: 10,
    auditCommand: () => {}, spawnProcess: () => child,
    killTree: async pid => { killedPid = pid; child.emit("close", null); },
  });
  const { jobId } = await manager.startTerminalCommand({ projectRoot: root, command: "Start-Sleep 600", purpose: "Bound lifetime" }, local);
  await new Promise(resolve => setTimeout(resolve, 35));
  expect(killedPid).toBe(12345);
  expect(manager.pcJobStatus(jobId, local).state).toBe("cancelled");
});

test("manual terminal cancellation clears its timeout and never kills the same tree twice", async () => {
  const local = new PcAuthorizer();
  local.setGrantFromLocalApproval({ id: "terminal-once-cancel", expiresAt: Date.now() + 60_000,
    roots: [root], permissions: ["jobs", "terminal.exec"], allowedApps: [] });
  let kills = 0;
  const manager = createPcJobManager({ projectRoot: root, commandSpecs: {}, platform: "win32", terminalTimeoutMs: 10,
    auditCommand: () => {}, spawnProcess: () => fakeChild(), killTree: async () => { kills++; },
  });
  const { jobId } = await manager.startTerminalCommand({ projectRoot: root, command: "Wait-Event", purpose: "Cancel timer" }, local);
  await manager.cancelPcJob(jobId, local);
  await new Promise(resolve => setTimeout(resolve, 35));
  expect(kills).toBe(1);
});
