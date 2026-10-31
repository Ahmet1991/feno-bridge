import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { PcAccessDeniedError, PcAuthorizer } from "./authorization";
import { applyPcPatch, createPcDirectory, createPcFile, listPcFiles, readPcFile } from "./files";
import { createPcJobManager, inferPcCommandSpecs, type PcJobKind, type PcTerminalAudit } from "./jobs";
import { inferPcDeveloperTasks } from "./developer-tasks";
import { resolveAllowedPath } from "./paths";
import { getRunnerStatus, type PcRunnerProbe } from "./runner";
import { createPcWindowsController, type PcDesktopInput } from "./windows";
import { createPcAdbController, resolveTrustedAdbPath, type PcAdbInput } from "./adb";

export interface PcHost {
  status(): Promise<unknown>;
  listFiles(path: string): Promise<unknown>;
  readFile(path: string): Promise<unknown>;
  applyPatch(path: string, sha256: string, patch: string): Promise<unknown>;
  createFile?(path: string, content: string): Promise<unknown>;
  createDirectory?(path: string): Promise<unknown>;
  startJob?(kind: PcJobKind, projectRoot: string): Promise<unknown>;
  listProjectTasks?(projectRoot: string): Promise<unknown>;
  startProjectTask?(projectRoot: string, taskId: string): Promise<unknown>;
  startTerminal?(projectRoot: string, command: string, purpose: string): Promise<unknown>;
  jobStatus?(jobId: string): Promise<unknown>;
  jobLogs?(jobId: string, cursor: number): Promise<unknown>;
  cancelJob?(jobId: string): Promise<unknown>;
  runnerStatus?(): Promise<unknown>;
  listWindows?(): Promise<unknown>;
  captureScreen?(windowId: string): Promise<{ mimeType: "image/png"; data: Uint8Array }>;
  desktopInput?(input: PcDesktopInput): Promise<unknown>;
  adbDevices?(): Promise<unknown>;
  adbInput?(serial: string, input: PcAdbInput): Promise<unknown>;
  adbScreencap?(serial: string): Promise<Uint8Array>;
  revokeActiveJobs?(): Promise<void>;
}

/** Default local host; intentionally exposes no generic shell or arbitrary RPC. */
export function createLocalPcHost(authorizer: PcAuthorizer, options: {
  jobManager?: ReturnType<typeof createPcJobManager>;
  auditCommand?: (record: PcTerminalAudit) => void;
  runnerProbe?: PcRunnerProbe;
  windowsController?: ReturnType<typeof createPcWindowsController>;
  adbController?: ReturnType<typeof createPcAdbController>;
} = {}): PcHost {
  const { runnerProbe } = options;
  let activeGrantId: string | undefined;
  type JobManager = ReturnType<typeof createPcJobManager>;
  const projectManagers = new Map<string, { manager: JobManager; tasks: string[] }>();
  const jobOwners = new Map<string, JobManager>();
  function managerForProject(projectRoot: string, allowEmpty = false) {
    const grant = authorizer.assert("jobs");
    const resolvedRoot = resolveAllowedPath(projectRoot, grant.roots);
    if (activeGrantId !== grant.id) {
      for (const { manager } of projectManagers.values()) void manager.revokeAll();
      projectManagers.clear();
      jobOwners.clear();
      activeGrantId = grant.id;
    }
    const existing = projectManagers.get(resolvedRoot);
    if (existing) return existing;
    if (projectManagers.size >= 16) throw new PcAccessDeniedError();
    const devSpecs = inferPcDeveloperTasks(resolvedRoot);
    const legacySpecs = inferPcCommandSpecs(resolvedRoot);
    if (!allowEmpty && !Object.keys(devSpecs).length && !Object.keys(legacySpecs).length) throw new PcAccessDeniedError();
    const manager = options.jobManager ?? createPcJobManager({ projectRoot: resolvedRoot,
      commandSpecs: { ...legacySpecs, ...devSpecs }, auditCommand: options.auditCommand });
    const entry = { manager, tasks: Object.keys(devSpecs).sort() };
    projectManagers.set(resolvedRoot, entry);
    return entry;
  }
  function ownerForJob(jobId: string): JobManager {
    const grant = authorizer.assert("jobs");
    if (grant.id !== activeGrantId) throw new PcAccessDeniedError();
    const manager = jobOwners.get(jobId);
    if (!manager) throw new PcAccessDeniedError();
    return manager;
  }
  function assertJobCapacity() {
    const active = [...projectManagers.values()].reduce((sum, entry) => sum + entry.manager.activeJobCount(), 0);
    if (active >= 4 || jobOwners.size >= 1_000) throw new PcAccessDeniedError();
  }
  const windowsController = options.windowsController ?? createPcWindowsController({ authorizer });
  const adbBinary = resolveTrustedAdbPath();
  const adbController = options.adbController ?? (adbBinary ? createPcAdbController({
    authorizer, adbPath: adbBinary,
    isEmulatorReserved: () => [...projectManagers.values()].some(({ manager }) => manager.isEmulatorBusy()),
  }) : undefined);
  return {
    status: async () => ({ platform: process.platform }),
    listFiles: async requested => listPcFiles(requested, ".", authorizer),
    readFile: async requested => readPcFile(requested, authorizer),
    applyPatch: async (requested, sha256, patch) => applyPcPatch(requested, sha256, patch, authorizer),
    createFile: async (requested, content) => createPcFile(requested, content, authorizer),
    createDirectory: async requested => createPcDirectory(requested, authorizer),
    startJob: async (kind, projectRoot) => {
      const { manager } = managerForProject(projectRoot);
      assertJobCapacity();
      const result = await manager.startPcJob({ kind, projectRoot }, authorizer);
      jobOwners.set(result.jobId, manager);
      return result;
    },
    listProjectTasks: async projectRoot => managerForProject(projectRoot).tasks,
    startProjectTask: async (projectRoot, taskId) => {
      const { manager, tasks } = managerForProject(projectRoot);
      if (!tasks.includes(taskId)) throw new PcAccessDeniedError();
      assertJobCapacity();
      const result = await manager.startDeveloperTask({ projectRoot, taskId }, authorizer);
      jobOwners.set(result.jobId, manager);
      return result;
    },
    startTerminal: async (projectRoot, command, purpose) => {
      authorizer.assert("terminal.exec");
      const { manager } = managerForProject(projectRoot, true);
      assertJobCapacity();
      if ([...projectManagers.values()].some(entry => entry.manager.hasActiveTerminal())) throw new PcAccessDeniedError();
      const result = await manager.startTerminalCommand({ projectRoot, command, purpose }, authorizer);
      jobOwners.set(result.jobId, manager);
      return result;
    },
    jobStatus: async jobId => {
      return ownerForJob(jobId).pcJobStatus(jobId, authorizer);
    },
    jobLogs: async (jobId, cursor) => {
      return ownerForJob(jobId).pcJobLogs(jobId, cursor, authorizer);
    },
    cancelJob: async jobId => {
      await ownerForJob(jobId).cancelPcJob(jobId, authorizer);
      return { cancelled: true };
    },
    revokeActiveJobs: async () => {
      await Promise.all([...projectManagers.values()].map(({ manager }) => manager.revokeAll()));
      projectManagers.clear();
      jobOwners.clear();
      activeGrantId = undefined;
    },
    runnerStatus: async () => getRunnerStatus({ label: "fenotip-tv" }, runnerProbe),
    listWindows: windowsController.listPcWindows,
    captureScreen: windowsController.capturePcWindow,
    desktopInput: windowsController.pcDesktopInput,
    adbDevices: async () => {
      if (!adbController) throw new PcAccessDeniedError();
      return adbController.adbDevices();
    },
    adbInput: async (serial, input) => {
      if (!adbController) throw new PcAccessDeniedError();
      return adbController.adbInput(serial, input);
    },
    adbScreencap: async serial => {
      if (!adbController) throw new PcAccessDeniedError();
      return adbController.adbScreenshot(serial);
    },
  };
}

function success(data: unknown, topLevelStatus = false) {
  const value = topLevelStatus && data && typeof data === "object" && !Array.isArray(data)
    ? { ok: true, ...data }
    : { ok: true, data };
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value };
}

function failure(error: unknown) {
  const code = error instanceof PcAccessDeniedError ? "pc_access_denied" : "pc_operation_failed";
  const value = { ok: false, code };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

async function runPcAction(action: () => Promise<unknown>, topLevelStatus = false) {
  try { return success(await action(), topLevelStatus); }
  catch (error) { return failure(error); }
}

async function runPcImage(action: () => Promise<Uint8Array>) {
  try {
    const bytes = await action();
    if (bytes.length < 8 || bytes.length > 6 * 1024 * 1024) throw new PcAccessDeniedError();
    return { content: [{ type: "image" as const, data: Buffer.from(bytes).toString("base64"), mimeType: "image/png" }] };
  } catch (error) { return failure(error); }
}

/**
 * This namespace is separate from the existing Codex broker. No `turn_token`
 * parameter is accepted; permission is strictly the launcher-owned PcAuthorizer.
 */
export function registerPcTools(server: McpServer, deps: {
  authorizer: PcAuthorizer;
  host: PcHost;
  beforeRequest?: () => void;
}): void {
  const { authorizer, host } = deps;
  const execute = (action: () => Promise<unknown>, topLevelStatus = false) => runPcAction(async () => {
    deps.beforeRequest?.();
    return action();
  }, topLevelStatus);
  const imageExecute = (action: () => Promise<Uint8Array>) => runPcImage(async () => {
    deps.beforeRequest?.();
    return action();
  });
  server.registerTool("pc_status", {
    title: "Akentek PC Bridge status",
    description: "Read whether locally approved PC control is enabled. Works without a Codex task; this tool never enables access.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, () => execute(async () => ({ ...authorizer.status(), ...(await host.status() as object) }), true));

  server.registerTool("pc_list_files", {
    title: "List files in an approved project",
    description: "List a directory within locally approved canonical project roots. Requires time-limited files.read permission.",
    inputSchema: { path: z.string().min(1).max(4096) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ path }) => execute(async () => { authorizer.assert("files.read"); return host.listFiles(path); }));

  server.registerTool("pc_read_file", {
    title: "Read an approved project text file",
    description: "Read a bounded text file within an approved project. Secrets and out-of-root paths are denied.",
    inputSchema: { path: z.string().min(1).max(4096) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ path }) => execute(async () => { authorizer.assert("files.read"); return host.readFile(path); }));

  server.registerTool("pc_write_patch", {
    title: "Apply an approved project patch",
    description: "Apply a bounded unified diff only when the local file matches the supplied SHA256, inside approved roots.",
    inputSchema: {
      path: z.string().min(1).max(4096),
      sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
      patch: z.string().min(1).max(256 * 1024),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, ({ path, sha256, patch }) => execute(async () => { authorizer.assert("files.write"); return host.applyPatch(path, sha256, patch); }));

  server.registerTool("pc_create_file", {
    title: "Create a new file in an approved project",
    description: "Create a bounded UTF-8 file only if it does not exist. Secret-like files and repository internals are denied.",
    inputSchema: { path: z.string().min(1).max(4096), content: z.string().max(256 * 1024) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, ({ path, content }) => execute(async () => {
    authorizer.assert("files.write");
    if (!host.createFile) throw new PcAccessDeniedError();
    return host.createFile(path, content);
  }));

  server.registerTool("pc_create_directory", {
    title: "Create a new directory in an approved project",
    description: "Create one previously absent directory within approved canonical project roots.",
    inputSchema: { path: z.string().min(1).max(4096) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, ({ path }) => execute(async () => {
    authorizer.assert("files.write");
    if (!host.createDirectory) throw new PcAccessDeniedError();
    return host.createDirectory(path);
  }));

  server.registerTool("pc_start_job", {
    title: "Start an approved PC build or test",
    description: "Launch one configured allowlisted test or Android build asynchronously. Arbitrary shell commands are unsupported.",
    inputSchema: {
      kind: z.enum(["typecheck", "unit-tests", "android-build", "playback-smoke"]),
      projectRoot: z.string().min(1).max(4096),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, ({ kind, projectRoot }) => execute(async () => {
    authorizer.assert("jobs");
    if (!host.startJob) throw new PcAccessDeniedError();
    return host.startJob(kind, projectRoot);
  }));

  server.registerTool("pc_list_project_tasks", {
    title: "List allowed developer tasks for an approved project",
    description: "Discover safe local test, build, lint, Android Gradle and read-only Git tasks. Never exposes arbitrary shell commands.",
    inputSchema: { projectRoot: z.string().min(1).max(4096) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ projectRoot }) => execute(async () => {
    authorizer.assert("jobs");
    if (!host.listProjectTasks) throw new PcAccessDeniedError();
    return host.listProjectTasks(projectRoot);
  }));

  server.registerTool("pc_start_project_task", {
    title: "Start one locally allowed developer task",
    description: "Run one catalog task by ID within a locally approved project; result is tracked through existing PC job status/log/cancel tools.",
    inputSchema: {
      projectRoot: z.string().min(1).max(4096),
      taskId: z.string().min(4).max(120).regex(/^(?:script:[a-zA-Z0-9:._-]+|android:[a-zA-Z]+|git:[a-z-]+)$/),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, ({ projectRoot, taskId }) => execute(async () => {
    authorizer.assert("jobs");
    if (!host.startProjectTask) throw new PcAccessDeniedError();
    return host.startProjectTask(projectRoot, taskId);
  }));

  server.registerTool("pc_start_terminal", {
    title: "Start a locally approved advanced Windows terminal command",
    description: "High-privilege local operation: requires separate Windows approval for terminal.exec as well as jobs. The working folder does not sandbox the Windows process.",
    inputSchema: {
      projectRoot: z.string().min(1).max(4096),
      command: z.string().min(1).max(2048).refine(value => !value.includes("\0")),
      purpose: z.string().min(3).max(160),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, ({ projectRoot, command, purpose }) => execute(async () => {
    authorizer.assert("terminal.exec");
    authorizer.assert("jobs");
    if (!host.startTerminal) throw new PcAccessDeniedError();
    return host.startTerminal(projectRoot, command, purpose);
  }));

  server.registerTool("pc_job_status", {
    title: "Read a PC job state",
    inputSchema: { jobId: z.string().uuid() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ jobId }) => execute(async () => {
    authorizer.assert("jobs");
    if (!host.jobStatus) throw new PcAccessDeniedError();
    return host.jobStatus(jobId);
  }));

  server.registerTool("pc_job_logs", {
    title: "Read redacted PC build logs",
    inputSchema: { jobId: z.string().uuid(), cursor: z.number().int().min(0).default(0) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ jobId, cursor }) => execute(async () => {
    authorizer.assert("jobs");
    if (!host.jobLogs) throw new PcAccessDeniedError();
    return host.jobLogs(jobId, cursor);
  }));

  server.registerTool("pc_cancel_job", {
    title: "Cancel a PC build job",
    inputSchema: { jobId: z.string().uuid() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ jobId }) => execute(async () => {
    authorizer.assert("jobs");
    if (!host.cancelJob) throw new PcAccessDeniedError();
    return host.cancelJob(jobId);
  }));

  server.registerTool("pc_runner_status", {
    title: "Read the existing Fenotip GitHub runner status",
    inputSchema: { label: z.literal("fenotip-tv") },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, () => execute(async () => {
    authorizer.assert("runner");
    if (!host.runnerStatus) throw new PcAccessDeniedError();
    return host.runnerStatus();
  }));

  server.registerTool("pc_list_windows", {
    title: "List locally allowed Windows desktop windows",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, () => execute(async () => {
    authorizer.assert("screen.read");
    if (!host.listWindows) throw new PcAccessDeniedError();
    return host.listWindows();
  }));

  server.registerTool("pc_capture_screen", {
    title: "Capture an approved desktop window as PNG",
    inputSchema: { windowId: z.string().regex(/^[1-9][0-9]{0,15}$/) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ windowId }) => imageExecute(async () => {
    authorizer.assert("screen.read");
    if (!host.captureScreen) throw new PcAccessDeniedError();
    const image = await host.captureScreen(windowId);
    if (image.mimeType !== "image/png") throw new PcAccessDeniedError();
    return image.data;
  }));

  server.registerTool("pc_desktop_input", {
    title: "Control an approved Windows desktop window",
    inputSchema: {
      windowId: z.string().regex(/^[1-9][0-9]{0,15}$/),
      action: z.enum(["click", "right_click", "scroll", "key", "type"]),
      x: z.number().int().min(0).max(8192).optional(),
      y: z.number().int().min(0).max(8192).optional(),
      delta: z.number().int().min(-1080).max(1080).optional(),
      key: z.string().max(24).optional(),
      text: z.string().max(300).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, input => execute(async () => {
    authorizer.assert("desktop.input");
    if (!host.desktopInput) throw new PcAccessDeniedError();
    return host.desktopInput(input);
  }));

  server.registerTool("pc_adb_devices", {
    title: "List Android TV emulator devices",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, () => execute(async () => {
    authorizer.assert("adb");
    if (!host.adbDevices) throw new PcAccessDeniedError();
    return host.adbDevices();
  }));

  server.registerTool("pc_adb_input", {
    title: "Send one validated emulator tap, key or text input",
    inputSchema: {
      serial: z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/),
      action: z.enum(["tap", "key", "text"]),
      x: z.number().int().min(0).max(8192).optional(),
      y: z.number().int().min(0).max(8192).optional(),
      value: z.string().max(150).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, ({ serial, ...input }) => execute(async () => {
    authorizer.assert("adb");
    if (!host.adbInput) throw new PcAccessDeniedError();
    return host.adbInput(serial, input);
  }));

  server.registerTool("pc_adb_screencap", {
    title: "Capture Android TV emulator PNG",
    inputSchema: { serial: z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ serial }) => imageExecute(async () => {
    authorizer.assert("adb");
    if (!host.adbScreencap) throw new PcAccessDeniedError();
    return host.adbScreencap(serial);
  }));
}
