import { PcAccessDeniedError } from "./authorization";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

export type PcRunnerState = "online" | "offline" | "unknown";
export type PcRunnerProbe = () => Promise<{ state: PcRunnerState; activeJob?: string; runnerName?: string; busy?: boolean }>;
const execFileAsync = promisify(execFile);
const MAX_RESPONSE_BYTES = 256 * 1024;

type RunGithubCommand = (executable: string, args: string[]) => Promise<string>;
const runGithubCommand: RunGithubCommand = async (executable, args) => {
  const { stdout } = await execFileAsync(executable, args, {
    encoding: "utf8", windowsHide: true, timeout: 8_000, maxBuffer: MAX_RESPONSE_BYTES,
  });
  return stdout;
};

/** Profile-local configuration is trusted; no MCP argument selects a repo, URL or executable. */
export function createConfiguredGithubRunnerProbe(directory: string, options: { runCommand?: RunGithubCommand } = {}): PcRunnerProbe | undefined {
  const configPath = join(directory, "pc-runner.json");
  if (!existsSync(configPath)) return undefined;
  const run = options.runCommand ?? runGithubCommand;
  return async () => {
    if (statSync(configPath).size > 16_384) throw new Error("invalid runner configuration");
    const configuration: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    if (!configuration || typeof configuration !== "object") throw new Error("invalid runner configuration");
    const { schema, repository, runnerName, label } = configuration as Record<string, unknown>;
    if (schema !== 1 || typeof repository !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(repository)
      || typeof runnerName !== "string" || !/^[a-zA-Z0-9_. -]{1,100}$/.test(runnerName)
      || label !== "fenotip-tv") throw new Error("invalid runner configuration");
    const installedGh = join(process.env.ProgramFiles || "C:\\Program Files", "GitHub CLI", "gh.exe");
    const executable = process.platform === "win32" && existsSync(installedGh) ? installedGh : "gh";
    const raw = await run(executable, ["api", "--hostname", "github.com", "--method", "GET",
      `repos/${repository}/actions/runners?per_page=100`]);
    if (Buffer.byteLength(raw) > MAX_RESPONSE_BYTES) throw new Error("oversized runner response");
    const body: unknown = JSON.parse(raw);
    if (!body || typeof body !== "object") throw new Error("invalid runner response");
    const { runners, total_count } = body as Record<string, unknown>;
    if (!Array.isArray(runners) || runners.length > 100 || !Number.isSafeInteger(total_count)
      || (total_count as number) < runners.length) throw new Error("invalid runner response");
    const matches = runners.filter(value => value && typeof value === "object" && value.name === runnerName
      && Array.isArray(value.labels) && value.labels.some((entry: unknown) => entry && typeof entry === "object"
        && (entry as { name?: unknown }).name === label));
    if (matches.length !== 1) return { state: "unknown" };
    const runner = matches[0];
    if (!["online", "offline"].includes(runner.status) || typeof runner.busy !== "boolean") {
      throw new Error("invalid runner state");
    }
    return { state: runner.status, runnerName, busy: runner.busy };
  };
}

/** No destructive Actions API call. A trusted launcher may install a read-only runner probe. */
export async function getRunnerStatus(
  options: { label: "fenotip-tv" },
  probe?: PcRunnerProbe,
): Promise<{ state: PcRunnerState; source: string; activeJob?: string; runnerName?: string; busy?: boolean }> {
  if (!options || options.label !== "fenotip-tv") throw new PcAccessDeniedError();
  if (!probe) return { state: "unknown", source: "not-configured" };
  try {
    const result = await probe();
    if (!["online", "offline", "unknown"].includes(result.state)) throw new Error("invalid probe result");
    const activeJob = result.activeJob && /^[a-zA-Z0-9_. -]{1,100}$/.test(result.activeJob)
      ? result.activeJob : undefined;
    const runnerName = result.runnerName && /^[a-zA-Z0-9_. -]{1,100}$/.test(result.runnerName) ? result.runnerName : undefined;
    return { state: result.state, source: "configured-probe", ...(activeJob ? { activeJob } : {}),
      ...(runnerName ? { runnerName } : {}), ...(typeof result.busy === "boolean" ? { busy: result.busy } : {}) };
  } catch {
    return { state: "unknown", source: "probe-error" };
  }
}
