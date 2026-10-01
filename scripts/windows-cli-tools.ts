import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Command-line tools the Windows runtime bundle ships for Codex. On 01.10 an A/B through the
 * bridge halved JSON-log tasks with jq (97 s -> 49 s, every answer correct) and shortened timing
 * tasks with hyperfine. Each tool is one MIT-licensed executable, pinned by version and SHA-256:
 * a download that does not match fails the build rather than shipping an unverified binary.
 */
export interface WindowsCliTool {
  name: string;
  version: string;
  url: string;
  /** SHA-256 of the downloaded asset. */
  sha256: string;
  /** Path of the executable inside a zip asset; absent when the asset is the executable. */
  member?: string;
  /** SHA-256 of the executable that ships. */
  executableSha256: string;
  license: string;
}

export const WINDOWS_CLI_TOOLS: readonly WindowsCliTool[] = [
  {
    name: "jq.exe",
    version: "1.8.2",
    url: "https://github.com/jqlang/jq/releases/download/jq-1.8.2/jq-windows-amd64.exe",
    sha256: "a6fc67fedaf9128a3309a1e2ebb8b986aeccf70122ee46d2cb4849e423f0c627",
    executableSha256: "a6fc67fedaf9128a3309a1e2ebb8b986aeccf70122ee46d2cb4849e423f0c627",
    license: "jq-1.8.2-COPYING.txt",
  },
  {
    name: "hyperfine.exe",
    version: "1.20.0",
    url: "https://github.com/sharkdp/hyperfine/releases/download/v1.20.0/hyperfine-v1.20.0-x86_64-pc-windows-msvc.zip",
    sha256: "2508c549b049b1d4342d08edc1cb42bfac169082b6e3069431b5bab9822dbb32",
    member: "hyperfine-v1.20.0-x86_64-pc-windows-msvc/hyperfine.exe",
    executableSha256: "fbad9dfc44e98e47aaaf352f83f9c5273fc5008658a2f38fb5844adc9fa9918b",
    license: "hyperfine-1.20.0-MIT.txt",
  },
];

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function verifiedAsset(tool: WindowsCliTool, cacheDir: string): Promise<string> {
  const cached = join(cacheDir, tool.url.slice(tool.url.lastIndexOf("/") + 1));
  if (existsSync(cached) && sha256(readFileSync(cached)) === tool.sha256) return cached;
  const response = await fetch(tool.url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${tool.name} ${tool.version} download failed: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = sha256(bytes);
  if (actual !== tool.sha256) {
    throw new Error(`${tool.name} ${tool.version} download has SHA-256 ${actual}, expected ${tool.sha256}`);
  }
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cached, bytes);
  return cached;
}

/** Downloads, verifies and copies the tools into `destination` (the bundle's `tools` folder). */
export async function stageWindowsCliTools(destination: string, cacheDir: string): Promise<void> {
  mkdirSync(destination, { recursive: true });
  for (const tool of WINDOWS_CLI_TOOLS) {
    const asset = await verifiedAsset(tool, cacheDir);
    const target = join(destination, tool.name);
    if (!tool.member) {
      copyFileSync(asset, target);
    } else {
      // Windows' own bsdtar reads zip archives; Git's GNU tar, which may come first on PATH, does not.
      const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
      const scratch = mkdtempSync(join(tmpdir(), "feno-cli-tool-"));
      try {
        const extract = Bun.spawnSync([tar, "-xf", asset, "-C", scratch, tool.member], { stdout: "pipe", stderr: "pipe" });
        if (extract.exitCode !== 0) {
          throw new Error(`${tool.name} could not be extracted: ${extract.stderr.toString() || extract.stdout.toString()}`);
        }
        copyFileSync(join(scratch, ...tool.member.split("/")), target);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }
    const actual = sha256(readFileSync(target));
    if (actual !== tool.executableSha256) {
      throw new Error(`${tool.name} ${tool.version} has SHA-256 ${actual}, expected ${tool.executableSha256}`);
    }
  }
}
