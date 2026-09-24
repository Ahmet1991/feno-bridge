const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runWindowsUpdateTransaction } = require("../electron/update-recovery.cjs");

test("a failed installer targeting a new directory restores the fallback installation and leaves the profile alone", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "feno-task33-fallback-"));
  const oldDir = path.join(root, "previous-app");
  const newDir = path.join(root, "new-app");
  const fallbackTarget = path.join(oldDir, "Feno Bridge.exe");
  const target = path.join(newDir, "Feno Bridge.exe");
  const profile = path.join(root, "profile", "session.json");
  const tempRoot = path.join(root, "update");
  fs.mkdirSync(path.join(oldDir, "resources"), { recursive: true });
  fs.mkdirSync(path.dirname(profile), { recursive: true });
  fs.mkdirSync(tempRoot);
  fs.writeFileSync(fallbackTarget, "old launcher");
  fs.writeFileSync(path.join(oldDir, "resources", "app.asar"), "old bundle");
  fs.writeFileSync(profile, "sentinel profile");
  try {
    let installerCalls = 0;
    let launchCalls = 0;
    let readyCalls = 0;
    await assert.rejects(
      runWindowsUpdateTransaction({
        target,
        fallbackTarget,
        tempRoot,
        version: "fixture-new",
      }, {
        runInstaller: () => {
          installerCalls++;
          assert.equal(fs.readFileSync(path.join(tempRoot, "previous-install", "resources", "app.asar"), "utf8"), "old bundle");
          fs.mkdirSync(newDir);
          fs.writeFileSync(target, "partial new launcher");
          fs.writeFileSync(path.join(newDir, "orphaned-file"), "partial payload");
          fs.writeFileSync(path.join(oldDir, "resources", "app.asar"), "damaged old bundle");
          throw new Error("synthetic installer failure");
        },
        launch: () => { launchCalls++; },
        waitForReadiness: () => { readyCalls++; },
      }),
      (error) => error.message === "synthetic installer failure" && error.rollbackRestored === true,
    );
    assert.equal(installerCalls, 1);
    assert.equal(launchCalls, 0);
    assert.equal(readyCalls, 0);
    assert.equal(fs.existsSync(newDir), false);
    assert.equal(fs.readFileSync(fallbackTarget, "utf8"), "old launcher");
    assert.equal(fs.readFileSync(path.join(oldDir, "resources", "app.asar"), "utf8"), "old bundle");
    assert.equal(fs.readFileSync(profile, "utf8"), "sentinel profile");
    assert.equal(fs.existsSync(path.join(tempRoot, "previous-install")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
