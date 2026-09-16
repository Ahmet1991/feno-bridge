import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

const REPOSITORY = "Ahmet1991/feno-bridge";
const ROOT = resolve(import.meta.dir, "..");
const VERSION_FILES = [
  "package.json",
  "launcher/package.json",
  "src/version.ts",
  "scripts/install.sh",
] as const;

type RunResult = { exitCode: number; stdout: string; stderr: string };

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
  const result = await run("gh", ["release", "view", tag, "--repo", REPOSITORY, "--json", "assets", "--jq", ".assets[].name"], true);
  if (result.exitCode !== 0) return false;
  const assets = new Set(result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  return assets.has(`feno-bridge-${version}-win-x64.exe`) && assets.has("checksums.txt");
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

  if (requestedVersion) parseStableVersion(requestedVersion);

  let targetVersion = requestedVersion ?? nextPatchVersion(beforeVersion);

  if (!dryRun) {
    await runChecked("git", ["--version"], true);
    await runChecked("gh", ["--version"], true);
    await runChecked("gh", ["auth", "status"], true);
    await runChecked("gh", ["repo", "view", REPOSITORY, "--json", "nameWithOwner"], true);

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
  console.log(`Repo: ${REPOSITORY}`);
  console.log("Akis: surum -> verify -> Windows setup -> checksum -> commit/tag -> private GitHub Release");
  console.log("GitHub Actions kullanilmayacak.");

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

    const installer = join(ROOT, "launcher", "artifacts", `feno-bridge-${targetVersion}-win-x64.exe`);
    if (!existsSync(installer)) throw new Error(`Installer was not created: ${installer}`);

    const installerHash = await sha256(installer);
    const checksums = join(ROOT, "launcher", "artifacts", "checksums.txt");
    writeFileSync(checksums, `${installerHash}  ${basename(installer)}\n`, "utf8");

    if (versionChanged) {
      await runChecked("git", ["add", ...VERSION_FILES]);
      await runChecked("git", ["commit", "-m", `chore: release v${targetVersion} [skip ci]`]);
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

    const releaseExists = (await run("gh", ["release", "view", tag, "--repo", REPOSITORY], true)).exitCode === 0;
    if (releaseExists) {
      await runChecked("gh", ["release", "upload", tag, installer, checksums, "--repo", REPOSITORY, "--clobber"]);
      await runChecked("gh", ["release", "edit", tag, "--repo", REPOSITORY, "--title", `Feno Bridge ${tag}`, "--draft=false", "--latest"]);
    } else {
      await runChecked("gh", [
        "release", "create", tag, installer, checksums,
        "--repo", REPOSITORY,
        "--title", `Feno Bridge ${tag}`,
        "--notes", "Private Windows release for Feno Bridge collaborators.",
        "--latest",
      ]);
    }

    const remoteAssets = await runChecked(
      "gh",
      ["release", "view", tag, "--repo", REPOSITORY, "--json", "assets", "--jq", ".assets[] | [.name, .digest] | @tsv"],
      true,
    );
    const expectedDigest = `sha256:${installerHash}`;
    const installerLine = remoteAssets.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith(`${basename(installer)}\t`));
    if (!installerLine || installerLine.split("\t")[1]?.trim() !== expectedDigest) {
      throw new Error(`Published installer digest mismatch for ${basename(installer)}`);
    }
    if (!remoteAssets.stdout.split(/\r?\n/).some((line) => line.startsWith("checksums.txt\t"))) {
      throw new Error("Published release is missing checksums.txt");
    }

    console.log(`YAYIN_TAMAM v${targetVersion}`);
    console.log(`SHA256 ${installerHash}`);
    console.log(`Diger Windows bilgisayarlar uygulama icinden v${targetVersion} guncellemesini gorebilir.`);
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
