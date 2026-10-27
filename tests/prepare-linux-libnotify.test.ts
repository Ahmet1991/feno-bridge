import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Linux libnotify selection ignores Meson .symbols files", () => {
  const script = readFileSync(join(import.meta.dir, "..", "scripts", "prepare-linux-libnotify.sh"), "utf8");
  const selection = script.match(/^LIBRARY="\$\((find [^\r\n]+)\)"$/m)?.[1];
  expect(selection).toBeDefined();

  const shell = process.platform === "win32"
    ? join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe")
    : "sh";
  const root = mkdtempSync(join(tmpdir(), "libnotify-selection-"));
  const build = join(root, "build", "libnotify");
  mkdirSync(build, { recursive: true });

  const select = () => {
    const result = spawnSync(shell, ["-c", selection!], {
      cwd: root,
      env: { ...process.env, TEMP_DIR: "." },
      encoding: "utf8",
    });
    expect(result.status, result.stderr || String(result.error)).toBe(0);
    return result.stdout.trim();
  };

  try {
    writeFileSync(join(build, "libnotify.so.4.0.0.symbols"), "Meson symbol metadata");
    expect(select()).toBe("");

    writeFileSync(join(build, "libnotify.so.4.0.0"), "Shared library fixture");
    expect(select()).toBe("./build/libnotify/libnotify.so.4.0.0");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
