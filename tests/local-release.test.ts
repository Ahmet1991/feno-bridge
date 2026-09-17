import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

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
  expect(releaseAssetsComplete(version, { isDraft: false, assets })).toBe(true);
  expect(releaseAssetsComplete(version, { isDraft: true, assets })).toBe(false);
  expect(releaseAssetsComplete(version, { isDraft: false, assets: assets.slice(1) })).toBe(false);
  expect(releaseAssetsComplete(version, { isDraft: false, assets: assets.map((asset) =>
    asset.name === "checksums.txt" ? { ...asset, digest: null } : asset) })).toBe(false);
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
  const packagePath = join(ROOT, "package.json");
  const before = await Bun.file(packagePath).text();
  const proc = Bun.spawn([
    process.execPath,
    "run",
    "scripts/release-windows.ts",
    "9.8.7",
    "--dry-run",
    "--yes",
  ], {
    cwd: ROOT,
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
});

test("YAYINLA wrapper offers the same one-command dry-run", async () => {
  if (process.platform !== "win32") return;
  const wrapper = join(ROOT, "YAYINLA.bat");
  const proc = Bun.spawn([
    process.env.COMSPEC || "cmd.exe",
    "/d",
    "/c",
    wrapper,
    "9.8.7",
    "--dry-run",
    "--yes",
  ], {
    cwd: ROOT,
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
});
