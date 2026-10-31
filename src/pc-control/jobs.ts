import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessByStdio, type SpawnOptionsWithoutStdio } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import type { Readable } from "node:stream";
import path from "node:path";
import { PcAccessDeniedError, PcAuthorizer } from "./authorization";
import { resolveAllowedPath } from "./paths";

export type PcJobKind = "typecheck" | "unit-tests" | "android-build" | "playback-smoke";
export type PcJobState = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type PcCommandSpec = { command: string; args: readonly string[]; usesEmulator: boolean };
type PcChild = ChildProcessByStdio<null, Readable, Readable>;
type PcSpawn = (command: string, args: string[], options: SpawnOptionsWithoutStdio) => PcChild;
type Job = {
  id: string; kind: string; state: PcJobState; createdAt: number; child: PcChild;
  lines: string[]; pending: string; baseCursor: number; exitCode?: number; usesEmulator: boolean; closed: boolean;
  timeout?: ReturnType<typeof setTimeout>;
};

export type PcTerminalAudit = { at: number; projectRoot: string; purpose: string; commandHash: string };

const JOB_KINDS = new Set<PcJobKind>(["typecheck", "unit-tests", "android-build", "playback-smoke"]);
const MAX_LOG_LINES = 1_000;
const MAX_LINE_LENGTH = 2_048;
const COMPLETED_TTL_MS = 60 * 60 * 1_000;
const TERMINAL_TIMEOUT_MS = 10 * 60 * 1_000;

/** Trusted fixed commands, activated only for scripts that really exist in the chosen project. */
export function inferPcCommandSpecs(projectRoot: string, platform: NodeJS.Platform = process.platform): Partial<Record<PcJobKind, PcCommandSpec>> {
  const configuredRoot = realpathSync.native(projectRoot);
  const specs: Partial<Record<PcJobKind, PcCommandSpec>> = {};
  let scripts: Record<string, unknown> = {};
  try {
    const manifest = resolveAllowedPath(path.join(configuredRoot, "package.json"), [configuredRoot]);
    const stats = readFileSync(manifest, "utf8");
    if (stats.length > 256 * 1024) throw new Error("large manifest");
    const parsed = JSON.parse(stats);
    if (parsed && typeof parsed.scripts === "object" && !Array.isArray(parsed.scripts)) scripts = parsed.scripts;
  } catch { /* No project-defined scripts: default deny. */ }
  if (typeof scripts.typecheck === "string") specs.typecheck = { command: process.execPath, args: ["run", "typecheck"], usesEmulator: false };
  if (typeof scripts.test === "string") specs["unit-tests"] = { command: process.execPath, args: ["run", "test"], usesEmulator: false };
  if (typeof scripts["playback-smoke"] === "string") {
    specs["playback-smoke"] = { command: process.execPath, args: ["run", "playback-smoke"], usesEmulator: true };
  }
  const wrapper = path.join(configuredRoot, "android", platform === "win32" ? "gradlew.bat" : "gradlew");
  try {
    if (existsSync(wrapper)) resolveAllowedPath(wrapper, [configuredRoot]);
    else throw new Error("missing wrapper");
    specs["android-build"] = platform === "win32"
      ? { command: path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe"),
        args: ["/d", "/s", "/c", "android\\gradlew.bat assembleDebug"], usesEmulator: true }
      : { command: "./android/gradlew", args: ["assembleDebug"], usesEmulator: true };
  } catch { /* Android builds remain unavailable until a trusted wrapper is verified. */ }
  return specs;
}

function redact(text: string): string {
  return text
    .replace(/\bBearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(/\b(token|password|secret|api[_-]?key|authorization)\s*[:=]\s*[^\s"']+/gi, "$1=[REDACTED]")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]+/g, "[REDACTED]")
    .slice(0, MAX_LINE_LENGTH);
}

async function defaultKillTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    const child = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    await new Promise<void>(resolve => { child.once("error", resolve); child.once("close", () => resolve()); });
  } else {
    try { process.kill(-pid, "SIGTERM"); }
    catch { try { process.kill(pid, "SIGTERM"); } catch { /* process may have already exited */ } }
  }
}

export function createPcJobManager(options: {
  projectRoot: string;
  commandSpecs: Record<string, PcCommandSpec>;
  spawnProcess?: PcSpawn;
  killTree?: (pid: number) => Promise<void>;
  clock?: () => number;
  platform?: NodeJS.Platform;
  terminalTimeoutMs?: number;
  auditCommand?: (record: PcTerminalAudit) => void;
}) {
  const clock = options.clock ?? Date.now;
  const configuredRoot = realpathSync.native(options.projectRoot);
  const spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) =>
    spawn(command, args, { ...spawnOptions, stdio: ["ignore", "pipe", "pipe"] }));
  const killTree = options.killTree ?? defaultKillTree;
  const jobs = new Map<string, Job>();
  let activeEmulatorJob: string | undefined;

  function trimJobs() {
    for (const [id, job] of jobs) {
      if (job.state !== "running" && clock() - job.createdAt > COMPLETED_TTL_MS) jobs.delete(id);
    }
  }

  function getJob(jobId: string, authorizer: PcAuthorizer): Job {
    authorizer.assert("jobs");
    if (typeof jobId !== "string" || !jobs.has(jobId)) throw new PcAccessDeniedError();
    return jobs.get(jobId)!;
  }

  function finish(job: Job, exitCode: number | null): void {
    job.closed = true;
    if (job.timeout) clearTimeout(job.timeout);
    if (job.state === "running") {
      job.exitCode = exitCode ?? undefined;
      job.state = exitCode === 0 ? "succeeded" : "failed";
    }
    if (activeEmulatorJob === job.id) activeEmulatorJob = undefined;
  }

  function appendLine(job: Job, raw: string) {
    job.lines.push(redact(raw));
    if (job.lines.length > MAX_LOG_LINES) {
      job.lines.shift();
      job.baseCursor++;
    }
  }

  function receiveChunk(job: Job, chunk: Buffer) {
    job.pending += chunk.toString("utf8");
    // Bound the incomplete line too, so an untrusted build cannot consume unbounded RAM.
    if (job.pending.length > MAX_LINE_LENGTH * 2) {
      appendLine(job, job.pending.slice(0, MAX_LINE_LENGTH));
      job.pending = "[truncated]";
    }
    let newline: number;
    while ((newline = job.pending.indexOf("\n")) !== -1) {
      appendLine(job, job.pending.slice(0, newline).replace(/\r$/, ""));
      job.pending = job.pending.slice(newline + 1);
    }
  }

  return {
    isEmulatorBusy: () => Boolean(activeEmulatorJob),
    hasActiveTerminal: () => [...jobs.values()].some(job => job.kind === "terminal" && !job.closed),
    activeJobCount: () => [...jobs.values()].filter(job => !job.closed).length,
    async startPcJob(input: { kind: PcJobKind; projectRoot: string }, authorizer: PcAuthorizer): Promise<{ jobId: string }> {
      if (!input || !JOB_KINDS.has(input.kind)) throw new PcAccessDeniedError();
      return startJob(input.kind, input.projectRoot, authorizer);
    },
    async startDeveloperTask(input: { taskId: string; projectRoot: string }, authorizer: PcAuthorizer): Promise<{ jobId: string }> {
      if (!input || typeof input.taskId !== "string" || !/^(?:script:[a-zA-Z0-9:._-]+|android:[a-zA-Z]+|git:[a-z-]+)$/.test(input.taskId)) {
        throw new PcAccessDeniedError();
      }
      return startJob(input.taskId, input.projectRoot, authorizer);
    },
    async startTerminalCommand(input: { projectRoot: string; command: string; purpose: string }, authorizer: PcAuthorizer): Promise<{ jobId: string }> {
      authorizer.assert("terminal.exec");
      authorizer.assert("jobs");
      const platform = options.platform ?? process.platform;
      if (platform !== "win32" || !options.auditCommand || !input
        || typeof input.command !== "string" || !input.command.trim() || input.command.length > 2_048
        || input.command.includes("\0") || typeof input.purpose !== "string"
        || input.purpose.length < 3 || input.purpose.length > 160 || activeTerminalCount() > 0) {
        throw new PcAccessDeniedError();
      }
      const grant = authorizer.assert("terminal.exec");
      const canonicalRoot = resolveAllowedPath(input.projectRoot, grant.roots);
      if (canonicalRoot !== configuredRoot) throw new PcAccessDeniedError();
      try {
        options.auditCommand({ at: clock(), projectRoot: configuredRoot,
          purpose: redact(input.purpose), commandHash: createHash("sha256").update(input.command).digest("hex") });
      } catch { throw new PcAccessDeniedError(); }
      const executable = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const spec: PcCommandSpec = { command: executable,
        args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", input.command], usesEmulator: false };
      return startJob("terminal", input.projectRoot, authorizer, spec);
    },
    pcJobStatus(jobId: string, authorizer: PcAuthorizer): { state: PcJobState; exitCode?: number } {
      const job = getJob(jobId, authorizer);
      return { state: job.state, ...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}) };
    },
    pcJobLogs(jobId: string, cursor: number = 0, authorizer: PcAuthorizer): { lines: string[]; nextCursor: number } {
      const job = getJob(jobId, authorizer);
      if (!Number.isSafeInteger(cursor) || cursor < 0) throw new PcAccessDeniedError();
      const nextCursor = job.baseCursor + job.lines.length;
      return { lines: job.lines.slice(Math.max(0, cursor - job.baseCursor)), nextCursor };
    },
    async cancelPcJob(jobId: string, authorizer: PcAuthorizer): Promise<void> {
      const job = getJob(jobId, authorizer);
      if (job.state !== "running") return;
      if (job.timeout) clearTimeout(job.timeout);
      const pid = job.child.pid;
      if (typeof pid === "number" && pid > 0) await killTree(pid);
      else job.child.kill("SIGTERM");
      job.state = "cancelled";
    },
    async revokeAll(): Promise<void> {
      await Promise.all([...jobs.values()].filter(job => job.state === "running").map(async job => {
        job.state = "cancelled";
        if (job.timeout) clearTimeout(job.timeout);
        try {
          if (job.child.pid) await killTree(job.child.pid);
          else job.child.kill("SIGTERM");
        } catch { /* revocation is irreversible even if OS process termination fails */ }
      }));
    },
  };

  function activeTerminalCount(): number {
    return [...jobs.values()].filter(job => job.kind === "terminal" && !job.closed).length;
  }

  async function startJob(kind: string, projectRoot: string, authorizer: PcAuthorizer, override?: PcCommandSpec): Promise<{ jobId: string }> {
      const grant = authorizer.assert("jobs");
      const resolved = resolveAllowedPath(projectRoot, grant.roots);
      if (resolved !== configuredRoot) throw new PcAccessDeniedError();
      const spec = override ?? (Object.prototype.hasOwnProperty.call(options.commandSpecs, kind) ? options.commandSpecs[kind] : undefined);
      if (!spec || typeof spec.command !== "string" || !spec.command || !Array.isArray(spec.args)) throw new PcAccessDeniedError();
      if (spec.usesEmulator && activeEmulatorJob) throw new PcAccessDeniedError();
      trimJobs();
      if (jobs.size >= 100 || [...jobs.values()].filter(job => !job.closed).length >= 4) throw new PcAccessDeniedError();
      const jobId = randomUUID();
      const child = spawnProcess(spec.command, [...spec.args], {
        cwd: resolved, shell: false, detached: process.platform !== "win32", windowsHide: true,
      });
      const job: Job = { id: jobId, kind, state: "running", createdAt: clock(), child,
        lines: [], pending: "", baseCursor: 0, usesEmulator: spec.usesEmulator, closed: false };
      jobs.set(jobId, job);
      if (kind === "terminal") {
        const configuredTimeout = options.terminalTimeoutMs ?? TERMINAL_TIMEOUT_MS;
        const timeoutMs = Math.min(TERMINAL_TIMEOUT_MS, Math.max(1, configuredTimeout));
        job.timeout = setTimeout(() => {
          job.state = "cancelled";
          const pid = job.child.pid;
          if (pid && pid > 0) void killTree(pid).catch(() => {});
          else job.child.kill("SIGTERM");
        }, timeoutMs);
        job.timeout.unref?.();
      }
      if (spec.usesEmulator) activeEmulatorJob = jobId;
      child.stdout.on("data", (chunk: Buffer) => receiveChunk(job, chunk));
      child.stderr.on("data", (chunk: Buffer) => receiveChunk(job, chunk));
      child.once("error", () => finish(job, null));
      child.once("close", code => {
        if (job.pending) appendLine(job, job.pending);
        job.pending = "";
        finish(job, code);
      });
      return { jobId };
  }
}
