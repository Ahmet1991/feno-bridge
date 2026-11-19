import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-verify-"));
const runtimeBundle = join(scratch, "runtime");

async function run(args: string[]): Promise<void> {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`Verification command failed (${exitCode}): bun ${args.join(" ")}`);
}

try {
  await run(["run", "check-version"]);
  await run(["run", "audit"]);
  await run(["run", "launcher:audit"]);
  await run(["run", "typecheck"]);
  // Electron 42 downloads its binary on first use. Do this outside timed tests.
  await run(["launcher/node_modules/electron/install.js"]);
  // The Windows key-map contract test uses the source-built helper on a clean checkout.
  if (process.platform === "win32") {
    const helper = Bun.spawn(["node", "scripts/build-pc-windows-helper.cjs"], { cwd: root, stdout: "inherit", stderr: "inherit" });
    if (await helper.exited !== 0) throw new Error("Windows test helper build failed");
  }
  await run(["run", "test"]);
  await run(["run", "launcher:typecheck"]);
  await run(["run", "launcher:test"]);
  await run(["run", "launcher:build"]);
  await run(["run", "scripts/build-runtime-bundle.ts", runtimeBundle]);
  await run([
    "run",
    "scripts/generate-third-party-notices.ts",
    join(scratch, "THIRD_PARTY_NOTICES.txt"),
    "--include-launcher",
  ]);
  await run(["run", "scripts/smoke-release.ts", runtimeBundle]);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
