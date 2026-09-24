import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

function createStableReleaseFixture(): string {
  const scratch = mkdtempSync(join(tmpdir(), "feno-release-dry-run-"));
  mkdirSync(join(scratch, "scripts"));
  copyFileSync(join(ROOT, "scripts", "release-windows.ts"), join(scratch, "scripts", "release-windows.ts"));
  copyFileSync(join(ROOT, "YAYINLA.bat"), join(scratch, "YAYINLA.bat"));
  writeFileSync(join(scratch, "package.json"), JSON.stringify({ version: "5.0.31" }));
  return scratch;
}

test("local Windows release chooses the next patch version", async () => {
  const { nextPatchVersion, releaseRuntimeIsMutableBuildPath, RELEASE_REPOSITORY, SOURCE_REPOSITORY } = await import("../scripts/release-windows");
  expect(SOURCE_REPOSITORY).toBe("Ahmet1991/feno-bridge");
  expect(RELEASE_REPOSITORY).toBe("Ahmet1991/feno-bridge");
  expect(releaseRuntimeIsMutableBuildPath(join(ROOT, "launcher", "build", "runtime", "runtime", "bun.exe"))).toBe(true);
  expect(releaseRuntimeIsMutableBuildPath(join(tmpdir(), "feno-release-bun.exe"))).toBe(false);
  expect(nextPatchVersion("5.0.5")).toBe("5.0.6");
  expect(nextPatchVersion("9.12.99")).toBe("9.12.100");
  expect(() => nextPatchVersion("5.0.5-beta.1")).toThrow(/stable x\.y\.z/i);
});

test("a public release is complete only with checksummed installers for every supported platform", async () => {
  const { releaseAssetsComplete } = await import("../scripts/release-windows");
  const version = "5.0.9";
  const names = [
    `feno-bridge-${version}-win-x64.exe`,
    "feno-bridge-setup.exe",
    `feno-bridge-${version}-mac-arm64.zip`,
    `feno-bridge-${version}-mac-x64.zip`,
    `feno-bridge-${version}-linux-x64.AppImage`,
    "checksums.txt",
  ];
  const assets = names.map((name) => ({ name, digest: `sha256:${"a".repeat(64)}` }));
  expect(releaseAssetsComplete(version, { isDraft: false, isPrerelease: false, assets })).toBe(true);
  expect(releaseAssetsComplete(version, { isDraft: true, assets })).toBe(false);
  expect(releaseAssetsComplete(version, { isDraft: false, isPrerelease: true, assets })).toBe(false);
  expect(releaseAssetsComplete(version, { isDraft: false, isPrerelease: false, assets: assets.slice(1) })).toBe(false);
  expect(releaseAssetsComplete(version, { isDraft: false, isPrerelease: false, assets: assets.map((asset) =>
    asset.name === "checksums.txt" ? { ...asset, digest: null } : asset) })).toBe(false);
});

test("release completion binds the Release workflow to the exact tag commit", async () => {
  const { releaseWorkflowState } = await import("../scripts/release-windows");
  const sha = "1".repeat(40);
  const otherSha = "2".repeat(40);
  const runs = [
    { headSha: otherSha, status: "completed", conclusion: "success", databaseId: 10 },
    { headSha: sha, status: "in_progress", conclusion: null, databaseId: 11 },
  ];

  expect(releaseWorkflowState(sha, runs)).toEqual({ status: "waiting", runId: 11 });
  expect(releaseWorkflowState(sha, [
    { headSha: sha, status: "completed", conclusion: "failure", databaseId: 12 },
  ])).toEqual({ status: "failed", conclusion: "failure", runId: 12 });
  expect(releaseWorkflowState(sha, [
    { headSha: sha, status: "completed", conclusion: "success", databaseId: 13 },
  ])).toEqual({ status: "success", runId: 13 });
  expect(releaseWorkflowState(sha, [
    { headSha: otherSha, status: "completed", conclusion: "success", databaseId: 14 },
  ])).toEqual({ status: "waiting", runId: null });
});

test("release prepares a stable setup download with matching checksums", async () => {
  const { prepareReleaseAssets } = await import("../scripts/release-windows");
  const scratch = mkdtempSync(join(tmpdir(), "feno-release-assets-"));
  const artifacts = join(scratch, "artifacts");
  const setup = join(scratch, "Setup");
  try {
    mkdirSync(artifacts);
    mkdirSync(setup);
    writeFileSync(join(setup, "feno-bridge-setup.exe"), "old installer");
    const versioned = join(artifacts, "feno-bridge-5.0.6-win-x64.exe");
    writeFileSync(versioned, "abc");

    const assets = await prepareReleaseAssets("5.0.6", artifacts, setup);
    expect(assets.installer).toBe(versioned);
    expect(assets.stableInstaller).toBe(join(setup, "feno-bridge-setup.exe"));
    expect(readFileSync(assets.stableInstaller, "utf8")).toBe("abc");
    expect(readFileSync(assets.checksums, "utf8")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  feno-bridge-5.0.6-win-x64.exe\n" +
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  feno-bridge-setup.exe\n",
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("local Windows release dry-run is safe and explicit", async () => {
  const scratch = createStableReleaseFixture();
  const packagePath = join(scratch, "package.json");
  const repositoryPackagePath = join(ROOT, "package.json");
  try {
    const before = await Bun.file(packagePath).text();
    const repositoryBefore = await Bun.file(repositoryPackagePath).text();
    const proc = Bun.spawn([
      process.execPath,
      "run",
      "scripts/release-windows.ts",
      "9.8.7",
      "--dry-run",
      "--yes",
    ], {
      cwd: scratch,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode, stderr).toBe(0);
    expect(stdout).toContain("YAYIN_PLANI v9.8.7");
    expect(stdout).toContain("DRY_RUN_OK");
    expect(await Bun.file(packagePath).text()).toBe(before);
    expect(await Bun.file(repositoryPackagePath).text()).toBe(repositoryBefore);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("local Windows release dry-run rejects a prerelease source version", async () => {
  const scratch = createStableReleaseFixture();
  try {
    const packagePath = join(scratch, "package.json");
    const prereleasePackage = JSON.stringify({ version: "5.0.31-rc.2" });
    writeFileSync(packagePath, prereleasePackage);
    const proc = Bun.spawn([
      process.execPath,
      "run",
      "scripts/release-windows.ts",
      "9.8.7",
      "--dry-run",
      "--yes",
    ], {
      cwd: scratch,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Version must be stable x.y.z, received: 5.0.31-rc.2");
    expect(stdout).not.toContain("DRY_RUN_OK");
    expect(await Bun.file(packagePath).text()).toBe(prereleasePackage);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("YAYINLA wrapper offers the same one-command dry-run", async () => {
  if (process.platform !== "win32") return;
  const scratch = createStableReleaseFixture();
  try {
    const wrapper = join(scratch, "YAYINLA.bat");
    const proc = Bun.spawn([
      process.env.COMSPEC || "cmd.exe",
      "/d",
      "/c",
      wrapper,
      "9.8.7",
      "--dry-run",
      "--yes",
    ], {
      cwd: scratch,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode, stderr).toBe(0);
    expect(stdout).toContain("YAYIN_PLANI v9.8.7");
    expect(stdout).toContain("DRY_RUN_OK");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
