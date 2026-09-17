import { createHash } from "node:crypto";
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

export const SOURCE_REPOSITORY = "Ahmet1991/feno-bridge";
export const RELEASE_REPOSITORY = "Ahmet1991/feno-bridge";
const ROOT = resolve(import.meta.dir, "..");
const STABLE_INSTALLER_NAME = "feno-bridge-setup.exe";
const VERSION_FILES = [
  "package.json",
  "launcher/package.json",
  "src/version.ts",
  "scripts/install.sh",
] as const;

type RunResult = { exitCode: number; stdout: string; stderr: string };

export function releaseRuntimeIsMutableBuildPath(executablePath: string): boolean {
  const mutableRoot = join(ROOT, "launcher", "build", "runtime");
  const candidate = resolve(executablePath);
  const fromMutableRoot = relative(mutableRoot, candidate);
  return fromMutableRoot === "" || (!fromMutableRoot.startsWith("..") && !isAbsolute(fromMutableRoot));
}

export function nextPatchVersion(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Auto versioning requires a stable x.y.z version, received: ${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function parseStableVersion(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Version must be stable x.y.z, received: ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareStableVersions(left: string, right: string): number {
  const a = parseStableVersion(left);
  const b = parseStableVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

async function run(command: string, args: string[], capture = false): Promise<RunResult> {
  const child = Bun.spawn([command, ...args], {
    cwd: ROOT,
    stdin: "inherit",
    stdout: capture ? "pipe" : "inherit",
    stderr: capture ? "pipe" : "inherit",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    capture ? new Response(child.stdout).text() : Promise.resolve(""),
    capture ? new Response(child.stderr).text() : Promise.resolve(""),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function runChecked(command: string, args: string[], capture = false): Promise<RunResult> {
  const result = await run(command, args, capture);
  if (result.exitCode !== 0) {
    const detail = capture ? `\n${result.stderr || result.stdout}` : "";
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.exitCode}${detail}`);
  }
  return result;
}

function currentVersion(): string {
  const parsed = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version?: string };
  if (!parsed.version) throw new Error("package.json has no version");
  parseStableVersion(parsed.version);
  return parsed.version;
}

async function releaseIsComplete(version: string): Promise<boolean> {
  const tag = `v${version}`;
  const result = await run("gh", ["release", "view", tag, "--repo", RELEASE_REPOSITORY, "--json", "isDraft,assets"], true);
  if (result.exitCode !== 0) return false;
  return releaseAssetsComplete(version, JSON.parse(result.stdout));
}

export function releaseAssetsComplete(version: string, release: {
  isDraft?: boolean;
  assets?: Array<{ name?: string; digest?: string | null }>;
}): boolean {
  if (release?.isDraft !== false || !Array.isArray(release.assets)) return false;
  const required = [
    `feno-bridge-${version}-win-x64.exe`,
    STABLE_INSTALLER_NAME,
    `feno-bridge-${version}-mac-arm64.zip`,
    `feno-bridge-${version}-mac-x64.zip`,
    `feno-bridge-${version}-linux-x64.AppImage`,
    "checksums.txt",
  ];
  return required.every((name) => release.assets!.some((asset) => asset.name === name
    && /^sha256:[a-f0-9]{64}$/i.test(asset.digest || "")));
}

async function waitForPublishedRelease(version: string): Promise<void> {
  const deadline = Date.now() + 30 * 60_000;
  const tag = `v${version}`;
  for (;;) {
    if (await releaseIsComplete(version)) return;
    const runs = await run("gh", [
      "run", "list", "--repo", RELEASE_REPOSITORY,
      "--workflow", "release.yml", "--branch", tag,
      "--limit", "1", "--json", "status,conclusion",
    ], true);
    if (runs.exitCode === 0) {
      const latest = JSON.parse(runs.stdout)[0];
      if (latest?.status === "completed" && latest.conclusion !== "success") {
        throw new Error(`GitHub Actions release failed for ${tag}: ${latest.conclusion}`);
      }
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for the public ${tag} release`);
    await Bun.sleep(30_000);
  }
}

async function gitTagExists(tag: string): Promise<boolean> {
  return (await run("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`], true)).exitCode === 0;
}

function replaceExactly(path: string, from: string, to: string): void {
  const absolute = join(ROOT, path);
  const original = readFileSync(absolute, "utf8");
  if (!original.includes(from)) throw new Error(`${path} does not contain expected version text: ${from}`);
  writeFileSync(absolute, original.replace(from, to), "utf8");
}

function updateVersions(fromVersion: string, toVersion: string): void {
  replaceExactly("package.json", `\"version\": \"${fromVersion}\"`, `\"version\": \"${toVersion}\"`);
  replaceExactly("launcher/package.json", `\"version\": \"${fromVersion}\"`, `\"version\": \"${toVersion}\"`);
  replaceExactly("src/version.ts", `export const VERSION = \"${fromVersion}\";`, `export const VERSION = \"${toVersion}\";`);
  replaceExactly(
    "scripts/install.sh",
    `VERSION=\"\${CODEX_CHATGPT_WEB_VERSION:-${fromVersion}}\"`,
    `VERSION=\"\${CODEX_CHATGPT_WEB_VERSION:-${toVersion}}\"`,
  );
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function prepareReleaseAssets(version: string, artifacts: string, setup: string): Promise<{
  installer: string;
  stableInstaller: string;
  checksums: string;
  installerHash: string;
}> {
  const installer = join(artifacts, `feno-bridge-${version}-win-x64.exe`);
  if (!existsSync(installer)) throw new Error(`Installer was not created: ${installer}`);
  const installerHash = await sha256(installer);
  mkdirSync(setup, { recursive: true });
  const stableInstaller = join(setup, STABLE_INSTALLER_NAME);
  const temporaryInstaller = `${stableInstaller}.tmp`;
  try {
    copyFileSync(installer, temporaryInstaller);
    if (await sha256(temporaryInstaller) !== installerHash) {
      throw new Error(`Setup copy checksum mismatch: ${temporaryInstaller}`);
    }
    renameSync(temporaryInstaller, stableInstaller);
  } finally {
    if (existsSync(temporaryInstaller)) unlinkSync(temporaryInstaller);
  }
  const checksums = join(artifacts, "checksums.txt");
  writeFileSync(checksums,
    `${installerHash}  ${basename(installer)}\n${installerHash}  ${STABLE_INSTALLER_NAME}\n`, "utf8");
  return { installer, stableInstaller, checksums, installerHash };
}

async function askToContinue(version: string): Promise<boolean> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await terminal.question(`v${version} yayinlansin mi? [E/h]: `)).trim().toLowerCase();
    return answer === "" || answer === "e" || answer === "evet" || answer === "y" || answer === "yes";
  } finally {
    terminal.close();
  }
}

async function restoreVersionFiles(): Promise<void> {
  await run("git", ["restore", "--", ...VERSION_FILES]);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const yes = args.includes("--yes") || args.includes("-y");
  const requestedVersion = args.find((arg) => !arg.startsWith("-"));
  const beforeVersion = currentVersion();

  if (!dryRun && releaseRuntimeIsMutableBuildPath(process.execPath)) {
    throw new Error("Release cannot run from launcher/build/runtime because packaging replaces that directory; use YAYINLA.bat or another Bun executable");
  }

  if (requestedVersion) parseStableVersion(requestedVersion);

  let targetVersion = requestedVersion ?? nextPatchVersion(beforeVersion);

  if (!dryRun) {
    await runChecked("git", ["--version"], true);
    await runChecked("gh", ["--version"], true);
    await runChecked("gh", ["auth", "status"], true);
    await runChecked("gh", ["repo", "view", SOURCE_REPOSITORY, "--json", "nameWithOwner"], true);
    const releaseVisibility = await runChecked("gh", ["repo", "view", RELEASE_REPOSITORY, "--json", "visibility", "--jq", ".visibility"], true);
    if (releaseVisibility.stdout.trim().toUpperCase() !== "PUBLIC") {
      throw new Error(`${RELEASE_REPOSITORY} must be public so installed Feno Bridge clients can update without GitHub credentials`);
    }

    const status = await runChecked("git", ["status", "--porcelain"], true);
    if (status.stdout.trim()) {
      throw new Error(`Repository is not clean. Commit or stash these changes first:\n${status.stdout.trim()}`);
    }

    if (!requestedVersion) {
      targetVersion = (await releaseIsComplete(beforeVersion)) ? nextPatchVersion(beforeVersion) : beforeVersion;
    }
  }

  const comparison = compareStableVersions(targetVersion, beforeVersion);
  if (comparison < 0) throw new Error(`Refusing to release older version ${targetVersion}; current is ${beforeVersion}`);

  console.log(`YAYIN_PLANI v${targetVersion}`);
  console.log(`Kaynak repo: ${SOURCE_REPOSITORY}`);
  console.log(`Guncelleme repo: ${RELEASE_REPOSITORY}`);
  console.log("Akis: surum -> verify -> Windows setup -> commit/tag -> GitHub Actions -> public GitHub Release");
  console.log("GitHub Actions tum platform paketlerini ve checksum dosyasini tek yayinda olusturacak.");

  if (dryRun) {
    console.log("DRY_RUN_OK");
    return;
  }

  if (await releaseIsComplete(targetVersion)) {
    console.log(`v${targetVersion} zaten eksiksiz yayinlanmis. Islem gerekmiyor.`);
    return;
  }

  if (!yes && !(await askToContinue(targetVersion))) {
    console.log("Yayin iptal edildi.");
    return;
  }

  const versionChanged = targetVersion !== beforeVersion;
  let releaseCommitCreated = false;

  try {
    if (versionChanged) updateVersions(beforeVersion, targetVersion);

    await runChecked(process.execPath, ["run", "verify"]);
    await runChecked(process.execPath, ["run", "--cwd", "launcher", "package:win"]);
    await runChecked(process.execPath, ["run", "app:smoke"]);

    await prepareReleaseAssets(
      targetVersion, join(ROOT, "launcher", "artifacts"), join(ROOT, "Setup"));

    if (versionChanged) {
      await runChecked("git", ["add", ...VERSION_FILES]);
      await runChecked("git", ["commit", "-m", `chore: release v${targetVersion}`]);
      releaseCommitCreated = true;
    }

    const tag = `v${targetVersion}`;
    if (await gitTagExists(tag)) {
      const tagCommit = (await runChecked("git", ["rev-list", "-n", "1", tag], true)).stdout.trim();
      const headCommit = (await runChecked("git", ["rev-parse", "HEAD"], true)).stdout.trim();
      if (tagCommit !== headCommit) throw new Error(`${tag} exists but does not point to HEAD`);
    } else {
      await runChecked("git", ["tag", "-a", tag, "-m", `Feno Bridge ${tag}`]);
    }

    await runChecked("git", ["push", "origin", "HEAD"]);
    await runChecked("git", ["push", "origin", tag]);
    console.log(`${tag} etiketi gonderildi; GitHub Actions yayini bekleniyor.`);
    await waitForPublishedRelease(targetVersion);

    console.log(`YAYIN_TAMAM v${targetVersion}`);
    console.log(`Diger bilgisayarlar uygulama icinden v${targetVersion} guncellemesini gorebilir.`);
  } catch (error) {
    if (versionChanged && !releaseCommitCreated) await restoreVersionFiles();
    throw error;
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`YAYIN_HATASI: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
