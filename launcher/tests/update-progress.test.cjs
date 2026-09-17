const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startWindowsUpdateProgress, showWindowsUpdateFailure } = require("../electron/update-progress.cjs");

test("Windows keeps update status visible through installation and relaunch", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "feno-update-progress-test-"));
  const windows = [];
  try {
    const progress = startWindowsUpdateProgress(root, {
      spawnProcess(executable, args) {
        const window = { executable, args, stopped: false };
        windows.push(window);
        return {
          on() {},
          unref() {},
          kill() { window.stopped = true; },
        };
      },
    });
    assert.equal(windows.length, 1);
    assert.equal(windows[0].executable, "wscript.exe");
    assert.match(fs.readFileSync(windows[0].args[0], "utf16le"), /başka kurulum başlatmayın/);
    progress.setPhase("opening");
    assert.equal(windows[0].stopped, true);
    assert.equal(windows.length, 2);
    assert.match(fs.readFileSync(windows[1].args[0], "utf16le"), /Feno Bridge açılıyor/);
    progress.stop();
    assert.equal(windows[1].stopped, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("failed update tells the user where to find the diagnostic log", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "feno-update-progress-test-"));
  try {
    let scriptPath;
    showWindowsUpdateFailure(root, {
      logPath: "C:\\Users\\tester\\logs\\update-worker.log",
      spawnProcess(_executable, args) {
        scriptPath = args[0];
        return { on() {}, unref() {} };
      },
    });
    assert.match(fs.readFileSync(scriptPath, "utf16le"), /C:\\Users\\tester\\logs\\update-worker\.log/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
