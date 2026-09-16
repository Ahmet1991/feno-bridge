import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

test("local Windows release chooses the next patch version", async () => {
  const { nextPatchVersion } = await import("../scripts/release-windows");
  expect(nextPatchVersion("5.0.5")).toBe("5.0.6");
  expect(nextPatchVersion("9.12.99")).toBe("9.12.100");
  expect(() => nextPatchVersion("5.0.5-beta.1")).toThrow(/stable x\.y\.z/i);
});

test("release prepares a stable setup download with matching checksums", async () => {
  const { prepareReleaseAssets } = await import("../scripts/release-windows");
  const artifacts = mkdtempSync(join(tmpdir(), "feno-release-assets-"));
  try {
    const versioned = join(artifacts, "feno-bridge-5.0.6-win-x64.exe");
    writeFileSync(versioned, "abc");

    const assets = await prepareReleaseAssets("5.0.6", artifacts);
    expect(assets.installer).toBe(versioned);
    expect(assets.stableInstaller).toBe(join(artifacts, "feno-bridge-setup.exe"));
    expect(readFileSync(assets.stableInstaller, "utf8")).toBe("abc");
    expect(readFileSync(assets.checksums, "utf8")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  feno-bridge-5.0.6-win-x64.exe\n" +
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  feno-bridge-setup.exe\n",
    );
  } finally {
    rmSync(artifacts, { recursive: true, force: true });
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
