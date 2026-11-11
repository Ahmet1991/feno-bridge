import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough, type Readable } from "node:stream";
import type { ChildProcessByStdio } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PcAuthorizer } from "../src/pc-control/authorization";
import { createPcJobManager } from "../src/pc-control/jobs";
import { createLocalPcHost } from "../src/pc-control/mcp-tools";

function approve(policy: PcAuthorizer, root: string, id: string) {
  policy.setGrantFromLocalApproval({ id, expiresAt: null, roots: [root], permissions: ["jobs"], allowedApps: [] });
}

test("host status distinguishes a busy terminal from approval and clears when its process closes",async()=>{
  const root=mkdtempSync(join(tmpdir(),"pc-busy-status-"));
  const policy=new PcAuthorizer();
  policy.setGrantFromLocalApproval({id:"busy-terminal-status-local",expiresAt:null,roots:[root],permissions:["jobs","terminal.exec"],allowedApps:[]});
  const child=Object.assign(new EventEmitter(),{pid:9020,stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>true}) as unknown as ChildProcessByStdio<null,Readable,Readable>;
  let spawns=0;
  const manager=createPcJobManager({projectRoot:root,commandSpecs:{},platform:"win32",auditCommand(){},spawnProcess:()=>{spawns++;return child;}});
  const host=createLocalPcHost(policy,{jobManager:manager});
  try{
    expect(await host.status()).toMatchObject({terminalBusy:false,activeJobs:0});
    await host.startTerminal!(root,"Get-Date","First approved terminal");
    expect(await host.status()).toMatchObject({terminalBusy:true,activeJobs:1});
    await expect(host.startTerminal!(root,"Get-Date","Second approved terminal")).rejects.toThrow("pc_terminal_busy");
    expect(spawns).toBe(1);expect(policy.status().enabled).toBe(true);
    child.emit("close",0);
    expect(await host.status()).toMatchObject({terminalBusy:false,activeJobs:0});
    await host.startTerminal!(root,"Get-Date","Terminal after completion");
    expect(spawns).toBe(2);child.emit("close",0);
    policy.revoke();
    expect(await host.status()).not.toHaveProperty("terminalBusy");
    await expect(host.startTerminal!(root,"Get-Date","No local approval")).rejects.toThrow("pc_access_denied");
  }finally{await manager.revokeAll();rmSync(root,{recursive:true,force:true});}
});

test("a retiring grant cannot erase the next grant's job ownership after a slow kill", async () => {
  const root = mkdtempSync(join(tmpdir(), "pc-revoke-generation-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "echo fixture" } }));
  const policy = new PcAuthorizer();
  approve(policy, root, "old-host-lifecycle-grant");
  const children: ChildProcessByStdio<null, Readable, Readable>[] = [];
  const killed: number[] = [];
  let releaseOld!: () => void;
  const oldKill = new Promise<void>(resolve => { releaseOld = resolve; });
  const manager = createPcJobManager({ projectRoot: root,
    commandSpecs: { "unit-tests": { command: "fixture", args: [], usesEmulator: false } },
    spawnProcess: () => {
      const child = Object.assign(new EventEmitter(), { pid: 9000 + children.length,
        stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true }) as unknown as ChildProcessByStdio<null, Readable, Readable>;
      children.push(child);
      return child;
    },
    killTree: async pid => {
      killed.push(pid);
      if (pid === 9000) await oldKill;
      children.find(child => child.pid === pid)?.emit("close", null);
    },
  });
  const host = createLocalPcHost(policy, { jobManager: manager });
  try {
    await host.startJob!("unit-tests", root);
    const retiring = host.revokeActiveJobs!();
    policy.revoke();
    approve(policy, root, "fresh-host-lifecycle-grant");
    const fresh = await host.startJob!("unit-tests", root) as { jobId: string };
    releaseOld();
    await retiring;
    expect(await host.jobStatus!(fresh.jobId)).toEqual({ state: "running" });
    await host.revokeActiveJobs!();
    expect(killed).toContain(9001);
  } finally {
    releaseOld();
    await manager.revokeAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("nested project managers share one emulator lease and reuse it after termination", async () => {
  const root = mkdtempSync(join(tmpdir(), "pc-shared-emulator-"));
  const alpha = join(root, "alpha"), beta = join(root, "beta");
  for (const project of [alpha, beta]) {
    mkdirSync(project);
    writeFileSync(join(project, "package.json"), JSON.stringify({ scripts: {
      "playback-smoke": `"${process.execPath}" -e "setInterval(() => {}, 1000)"`,
    } }));
  }
  const policy = new PcAuthorizer();
  approve(policy, root, "shared-emulator-local-grant");
  const host = createLocalPcHost(policy);
  try {
    const first = await host.startJob!("playback-smoke", alpha) as { jobId: string };
    await expect(host.startJob!("playback-smoke", beta)).rejects.toThrow("pc_access_denied");
    await host.cancelJob!(first.jobId);
    await Bun.sleep(100);
    expect(await host.jobStatus!(first.jobId)).toEqual({ state: "cancelled" });
    expect(await host.startJob!("playback-smoke", beta)).toHaveProperty("jobId");
  } finally {
    await host.revokeActiveJobs!();
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

test("a start completing after grant rotation cannot register its old job in the new generation", async () => {
  const root = mkdtempSync(join(tmpdir(), "pc-start-generation-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "echo fixture" } }));
  const policy = new PcAuthorizer();
  approve(policy, root, "old-start-generation-grant");
  const child = Object.assign(new EventEmitter(), { pid: 9010, stdout: new PassThrough(),
    stderr: new PassThrough(), kill: () => true }) as unknown as ChildProcessByStdio<null, Readable, Readable>;
  const manager = createPcJobManager({ projectRoot: root,
    commandSpecs: { "unit-tests": { command: "fixture", args: [], usesEmulator: false } },
    spawnProcess: () => child, killTree: async () => { child.emit("close", null); },
  });
  const host = createLocalPcHost(policy, { jobManager: manager });
  try {
    const starting = host.startJob!("unit-tests", root);
    const retiring = host.revokeActiveJobs!();
    policy.revoke();
    approve(policy, root, "fresh-start-generation-grant");
    await expect(starting).rejects.toThrow("pc_access_denied");
    await retiring;
  } finally { await manager.revokeAll(); rmSync(root, { recursive: true, force: true }); }
});

test("the default host reads the profile's runner configuration without requiring injected wiring", async () => {
  const root = mkdtempSync(join(tmpdir(), "pc-host-runner-default-"));
  const previous = process.env.CODEX_CHATGPT_WEB_HOME;
  try {
    process.env.CODEX_CHATGPT_WEB_HOME = root;
    writeFileSync(join(root, "pc-runner.json"), "invalid configuration");
    const host = createLocalPcHost(new PcAuthorizer());
    expect(await host.runnerStatus!()).toEqual({ state: "unknown", source: "probe-error" });
  } finally {
    if (previous === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
    else process.env.CODEX_CHATGPT_WEB_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
