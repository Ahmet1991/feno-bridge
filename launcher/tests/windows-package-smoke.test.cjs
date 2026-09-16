const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("Windows package smoke extracts its payload without executing the installer", {
  skip: process.platform !== "win32",
}, () => {
  const { stageWindowsSmoke } = require("../scripts/stage-windows-smoke.cjs");
  const extractor = path.join(path.dirname(require.resolve("electron-winstaller/package.json")), "vendor", "7z.exe");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "feno-smoke-extraction-test-"));
  const source = path.join(root, "source");
  const container = path.join(root, "container");
  const scratch = path.join(root, "scratch");
  const installer = path.join(root, "fixture-installer.exe");
  const calls = [];
  function extract(command, args, options = {}) {
    calls.push({ command, args });
    // Fail before launching anything if the smoke route tries a real installation.
    assert.equal(command, extractor);
    const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, ...options });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  try {
    fs.mkdirSync(source);
    fs.mkdirSync(path.join(container, "$PLUGINSDIR"), { recursive: true });
    fs.mkdirSync(scratch);
    fs.writeFileSync(path.join(source, "Feno Bridge.exe"), "packaged application fixture");
    extract(extractor, ["a", path.join(container, "$PLUGINSDIR", "app-64.7z"), "Feno Bridge.exe"], { cwd: source });
    extract(extractor, ["a", "-t7z", installer, "$PLUGINSDIR"], { cwd: container });
    calls.length = 0;

    const executable = stageWindowsSmoke({ installer, scratch, productName: "Feno Bridge", run: extract });
    assert.equal(executable, path.join(scratch, "windows-app", "Feno Bridge.exe"));
    assert.equal(fs.readFileSync(executable, "utf8"), "packaged application fixture");
    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => call.command === extractor));
    assert.ok(calls.every(call => !call.args.includes("/S") && !call.args.includes("/currentuser")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
