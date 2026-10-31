import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { resolveAllowedPath } from "./paths";
import type { PcCommandSpec } from "./jobs";

const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_TASKS = 64;
const SAFE_SCRIPT = /^(?:test|lint|check|typecheck|build|verify)(?::[a-zA-Z0-9._-]+)*$/;
const BLOCKED_SCRIPT_SEGMENT = /deploy|release|publish|production|prod|wipe|clean|reset|delete|install|update|migrate|seed|push|upload|ship/i;

/**
 * A catalog of selected development operations, resolved locally from a single
 * project. The remote caller supplies only a task ID, never a command or args.
 * Task scripts run as the Windows user: this is NOT an OS filesystem sandbox.
 */
export function inferPcDeveloperTasks(
  projectRoot: string,
  platform: NodeJS.Platform = process.platform,
): Record<string, PcCommandSpec> {
  const configuredRoot = realpathSync.native(projectRoot);
  const tasks: Record<string, PcCommandSpec> = {};
  let scripts: Record<string, unknown> = {};
  try {
    const manifest = resolveAllowedPath(path.join(configuredRoot, "package.json"), [configuredRoot]);
    if (statSync(manifest).size > MAX_MANIFEST_BYTES) throw new Error("large manifest");
    const parsed = JSON.parse(readFileSync(manifest, "utf8"));
    if (parsed && typeof parsed.scripts === "object" && !Array.isArray(parsed.scripts)) {
      scripts = parsed.scripts;
    }
  } catch { /* A project without a manifest may still have a Gradle wrapper or Git worktree. */ }

  for (const name of Object.keys(scripts).sort()) {
    if (Object.keys(tasks).length >= MAX_TASKS) break;
    if (!SAFE_SCRIPT.test(name) || BLOCKED_SCRIPT_SEGMENT.test(name)) continue;
    if (typeof scripts[name] !== "string" || !(scripts[name] as string).trim()) continue;
    tasks[`script:${name}`] = { command: process.execPath, args: ["run", name], usesEmulator: false };
  }

  const gradle = path.join(configuredRoot, "android", platform === "win32" ? "gradlew.bat" : "gradlew");
  try {
    if (!existsSync(gradle) || !statSync(resolveAllowedPath(gradle, [configuredRoot])).isFile()) throw new Error("no wrapper");
    for (const task of ["assembleDebug", "testDebugUnitTest", "lintDebug"] as const) {
      if (Object.keys(tasks).length >= MAX_TASKS) break;
      tasks[`android:${task}`] = platform === "win32"
        ? {
          command: path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe"),
          args: ["/d", "/s", "/c", `android\\gradlew.bat ${task}`], usesEmulator: false,
        }
        : { command: "./android/gradlew", args: [task], usesEmulator: false };
    }
  } catch { /* Do not expose Android tasks if the project wrapper is missing or escaped the root. */ }

  try {
    const gitMarker = resolveAllowedPath(path.join(configuredRoot, ".git"), [configuredRoot]);
    if (existsSync(gitMarker) && Object.keys(tasks).length + 3 <= MAX_TASKS) {
      tasks["git:status"] = { command: "git", args: ["-c", "core.pager=cat", "status", "--short", "--branch"], usesEmulator: false };
      tasks["git:diff-stat"] = { command: "git", args: ["-c", "core.pager=cat", "diff", "--stat"], usesEmulator: false };
      tasks["git:log"] = { command: "git", args: ["-c", "core.pager=cat", "log", "-5", "--oneline"], usesEmulator: false };
    }
  } catch { /* Not a verified Git project. */ }

  return tasks;
}
