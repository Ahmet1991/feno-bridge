import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessByStdio, type SpawnOptionsWithoutStdio } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";
import { PcAccessDeniedError, PcAuthorizer } from "./authorization";
import { resolveAllowedPath } from "./paths";
import { containedWindowsTerminalSpec } from "./terminal-containment";
import { PcOperationError } from "./errors";

export type PcJobKind = "typecheck" | "unit-tests" | "android-build" | "playback-smoke";
export type PcJobState = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type PcCommandSpec = { command: string; args: readonly string[]; usesEmulator: boolean };
type PcChild = ChildProcessByStdio<null, Readable, Readable>;
type PcSpawn = (command: string, args: string[], options: SpawnOptionsWithoutStdio) => PcChild;
type LogStream = { decoder: StringDecoder; pending: string; overflowed: boolean };
type Job = {
  id: string; kind: string; state: PcJobState; createdAt: number; child: PcChild;
  lines: string[]; streams: { stdout: LogStream; stderr: LogStream }; logBytes: number; baseCursor: number; exitCode?: number; usesEmulator: boolean; closed: boolean;
  timeout?: ReturnType<typeof setTimeout>;
  releaseResources: () => void;
  termination?: Promise<void>;
};

export type PcTerminalAudit = { at: number; projectRoot: string; purpose: string; commandHash: string };

const JOB_KINDS = new Set<PcJobKind>(["typecheck", "unit-tests", "android-build", "playback-smoke"]);
const MAX_LOG_LINES = 20_000;
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const LOG_PAGE_LINES = 250;
const LOG_PAGE_BYTES = 64 * 1024;
const MAX_LINE_LENGTH = 2_048;
const COMPLETED_TTL_MS = 60 * 60 * 1_000;
const TERMINAL_TIMEOUT_MS = 10 * 60 * 1_000;

/** Shared by every project and retiring grant owned by one PC host. */
export function createPcJobResources() {
  let activeJobs = 0, emulator = false, terminal = false;
  return {
    activeJobCount: () => activeJobs,
    isEmulatorBusy: () => emulator,
    hasActiveTerminal: () => terminal,
    reserve(usesEmulator: boolean, isTerminal: boolean) {
      if (activeJobs >= 4) throw new PcOperationError("pc_job_busy");
      if (isTerminal && terminal) throw new PcOperationError("pc_terminal_busy");
      if (usesEmulator && emulator) throw new PcAccessDeniedError();
      activeJobs++;
      if (usesEmulator) emulator = true;
      if (isTerminal) terminal = true;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        activeJobs--;
        if (usesEmulator) emulator = false;
        if (isTerminal) terminal = false;
      };
    },
  };
}

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
  resources?: ReturnType<typeof createPcJobResources>;
}) {
  const clock = options.clock ?? Date.now;
  const configuredRoot = realpathSync.native(options.projectRoot);
  const spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) =>
    spawn(command, args, { ...spawnOptions, stdio: ["ignore", "pipe", "pipe"] }));
  const killTree = options.killTree ?? defaultKillTree;
  const jobs = new Map<string, Job>();
  const resources = options.resources ?? createPcJobResources();
  let activeEmulatorJob: string | undefined;

  function trimJobs() {
    for (const [id, job] of jobs) {
      if (job.closed && clock() - job.createdAt > COMPLETED_TTL_MS) jobs.delete(id);
    }
  }

  function getJob(jobId: string, authorizer: PcAuthorizer): Job {
    authorizer.assert("jobs");
    if (typeof jobId !== "string" || !jobs.has(jobId)) throw new PcAccessDeniedError();
    return jobs.get(jobId)!;
  }

  function finish(job: Job, exitCode: number | null): void {
    if (job.closed) return;
    job.closed = true;
    if (job.timeout) clearTimeout(job.timeout);
    job.releaseResources();
    if (job.state === "running") {
      job.exitCode = exitCode ?? undefined;
      job.state = exitCode === 0 ? "succeeded" : "failed";
    }
    if (activeEmulatorJob === job.id) activeEmulatorJob = undefined;
  }

  function appendLine(job: Job, raw: string) {
    const line = redact(raw);
    job.lines.push(line);
    job.logBytes += Buffer.byteLength(line, "utf8");
    while (job.lines.length > MAX_LOG_LINES || job.logBytes > MAX_LOG_BYTES) {
      job.logBytes -= Buffer.byteLength(job.lines.shift()!, "utf8");
      job.baseCursor++;
    }
  }

  function flushLine(job: Job, stream: LogStream) {
    appendLine(job, stream.overflowed
      ? stream.pending.slice(0, MAX_LINE_LENGTH - 11) + "[truncated]"
      : stream.pending.replace(/\r$/, ""));
    stream.pending = "";
    stream.overflowed = false;
  }

  function receiveText(job: Job, stream: LogStream, text: string) {
    let offset = 0;
    while (offset < text.length) {
      const newline = text.indexOf("\n", offset);
      const end = newline < 0 ? text.length : newline;
      // Bound each incomplete line, not the whole chunk: a chunk can contain
      // thousands of complete lines. Decode stdout/stderr independently as UTF-8.
      const room = MAX_LINE_LENGTH * 2 - stream.pending.length;
      stream.pending += text.slice(offset, Math.min(end, offset + room));
      if (end - offset > room) stream.overflowed = true;
      if (newline < 0) break;
      flushLine(job, stream);
      offset = newline + 1;
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
        || input.purpose.length < 3 || input.purpose.length > 160) {
        throw new PcAccessDeniedError();
      }
      const grant = authorizer.assert("terminal.exec");
      const canonicalRoot = resolveAllowedPath(input.projectRoot, grant.roots);
      if (canonicalRoot !== configuredRoot) throw new PcAccessDeniedError();
      if (activeTerminalCount() > 0) throw new PcOperationError("pc_terminal_busy");
      try {
        options.auditCommand({ at: clock(), projectRoot: configuredRoot,
          purpose: redact(input.purpose), commandHash: createHash("sha256").update(input.command).digest("hex") });
      } catch { throw new PcAccessDeniedError(); }
      const spec = containedWindowsTerminalSpec(input.command, terminalTimeout());
      return startJob("terminal", input.projectRoot, authorizer, spec);
    },
    pcJobStatus(jobId: string, authorizer: PcAuthorizer): { state: PcJobState; exitCode?: number } {
      const job = getJob(jobId, authorizer);
      return { state: job.state, ...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}) };
    },
    pcJobLogs(jobId: string, cursor: number = 0, authorizer: PcAuthorizer): {
      lines: string[]; nextCursor: number; firstCursor: number; endCursor: number; truncated: boolean;
    } {
      const job = getJob(jobId, authorizer);
      if (!Number.isSafeInteger(cursor) || cursor < 0) throw new PcAccessDeniedError();
      const start = Math.min(job.lines.length, Math.max(0, cursor - job.baseCursor));
      const lines: string[] = [];
      let bytes = 0;
      for (let index = start; index < job.lines.length && lines.length < LOG_PAGE_LINES; index++) {
        const line = job.lines[index]!;
        const size = Buffer.byteLength(line, "utf8");
        if (bytes + size > LOG_PAGE_BYTES) break;
        lines.push(line); bytes += size;
      }
      return { lines, nextCursor: job.baseCursor + start + lines.length,
        firstCursor: job.baseCursor, endCursor: job.baseCursor + job.lines.length, truncated: job.baseCursor > 0 };
    },
    async cancelPcJob(jobId: string, authorizer: PcAuthorizer): Promise<void> {
      const job = getJob(jobId, authorizer);
      await terminate(job);
    },
    async revokeAll(): Promise<void> {
      await Promise.all([...jobs.values()].filter(job => !job.closed).map(job => terminate(job).catch(() => {})));
    },
  };

  function activeTerminalCount(): number {
    return [...jobs.values()].filter(job => job.kind === "terminal" && !job.closed).length;
  }

  function terminalTimeout(): number {
    const configured = options.terminalTimeoutMs ?? TERMINAL_TIMEOUT_MS;
    return Number.isFinite(configured) ? Math.min(TERMINAL_TIMEOUT_MS, Math.max(1, Math.trunc(configured))) : TERMINAL_TIMEOUT_MS;
  }

  function terminate(job: Job): Promise<void> {
    if (job.closed) return Promise.resolve();
    if (job.termination) return job.termination;
    job.state = "cancelled";
    if (job.timeout) clearTimeout(job.timeout);
    job.termination = (async () => {
      const pid = job.child.pid;
      if (typeof pid === "number" && pid > 0) await killTree(pid);
      else job.child.kill("SIGTERM");
    })();
    // Leases remain held until the process actually closes, including during a slow/failed kill.
    return job.termination;
  }

  async function startJob(kind: string, projectRoot: string, authorizer: PcAuthorizer, override?: PcCommandSpec): Promise<{ jobId: string }> {
      const grant = authorizer.assert("jobs");
      const resolved = resolveAllowedPath(projectRoot, grant.roots);
      if (resolved !== configuredRoot) throw new PcAccessDeniedError();
      const spec = override ?? (Object.prototype.hasOwnProperty.call(options.commandSpecs, kind) ? options.commandSpecs[kind] : undefined);
      if (!spec || typeof spec.command !== "string" || !spec.command || !Array.isArray(spec.args)) throw new PcAccessDeniedError();
      if (spec.usesEmulator && activeEmulatorJob) throw new PcAccessDeniedError();
      trimJobs();
      if (jobs.size >= 100) throw new PcOperationError("pc_job_history_full");
      if ([...jobs.values()].filter(job => !job.closed).length >= 4) throw new PcOperationError("pc_job_busy");
      const releaseResources = resources.reserve(spec.usesEmulator, kind === "terminal");
      const jobId = randomUUID();
      let child: PcChild;
      try {
        child = spawnProcess(spec.command, [...spec.args], {
          cwd: resolved, shell: false, detached: process.platform !== "win32", windowsHide: true,
        });
      } catch (error) { releaseResources(); throw error; }
      const stream = (): LogStream => ({ decoder: new StringDecoder("utf8"), pending: "", overflowed: false });
      const job: Job = { id: jobId, kind, state: "running", createdAt: clock(), child,
        lines: [], streams: { stdout: stream(), stderr: stream() }, logBytes: 0,
        baseCursor: 0, usesEmulator: spec.usesEmulator, closed: false, releaseResources };
      jobs.set(jobId, job);
      if (kind === "terminal") {
        job.timeout = setTimeout(() => {
          void terminate(job).catch(() => {});
        }, terminalTimeout());
        job.timeout.unref?.();
      }
      if (spec.usesEmulator) activeEmulatorJob = jobId;
      child.stdout.on("data", (chunk: Buffer) => receiveText(job, job.streams.stdout, job.streams.stdout.decoder.write(chunk)));
      child.stderr.on("data", (chunk: Buffer) => receiveText(job, job.streams.stderr, job.streams.stderr.decoder.write(chunk)));
      child.once("error", () => finish(job, null));
      child.once("close", code => {
        for (const stream of Object.values(job.streams)) {
          receiveText(job, stream, stream.decoder.end());
          if (stream.pending || stream.overflowed) flushLine(job, stream);
        }
        finish(job, code);
      });
      return { jobId };
  }
}
