import { expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

test("local Windows release chooses the next patch version", async () => {
  const { nextPatchVersion } = await import("../scripts/release-windows");
  expect(nextPatchVersion("5.0.5")).toBe("5.0.6");
  expect(nextPatchVersion("9.12.99")).toBe("9.12.100");
  expect(() => nextPatchVersion("5.0.5-beta.1")).toThrow(/stable x\.y\.z/i);
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
