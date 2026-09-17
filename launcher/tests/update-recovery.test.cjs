const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runWindowsUpdateTransaction } = require("../electron/update-recovery.cjs");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "feno-update-recovery-"));
  const installDir = path.join(root, "Feno Bridge");
  const target = path.join(installDir, "Feno Bridge.exe");
  const profile = path.join(root, "profile", "settings.json");
  const tempRoot = path.join(root, "update");
  const installer = path.join(tempRoot, "setup.exe");
  fs.mkdirSync(installDir, { recursive: true });
  fs.mkdirSync(path.dirname(profile), { recursive: true });
  fs.mkdirSync(tempRoot, { recursive: true });
  fs.writeFileSync(target, "old launcher");
  fs.writeFileSync(path.join(installDir, "app.asar"), "old app");
  fs.writeFileSync(profile, "user settings");
  fs.writeFileSync(installer, "installer bytes");
  return {
    root,
    installDir,
    target,
    profile,
    job: {
      version: "5.0.13",
      tempRoot,
      source: installer,
      target,
      fallbackTarget: target,
      readyPath: path.join(root, "logs", "launcher-ready.json"),
    },
  };
}

test("Windows installer failure restores the previous application without touching the user profile", async () => {
  const fx = fixture();
  try {
    await assert.rejects(
      runWindowsUpdateTransaction(fx.job, {
        runInstaller: () => {
          fs.writeFileSync(fx.target, "partial launcher");
          fs.writeFileSync(path.join(fx.installDir, "app.asar"), "partial app");
          throw new Error("injected installer failure");
        },
        launch: () => assert.fail("failed installer must not launch the new application"),
        waitForReadiness: () => assert.fail("failed installer must not wait for readiness"),
      }),
      /injected installer failure/,
    );
    assert.equal(fs.readFileSync(fx.target, "utf8"), "old launcher");
    assert.equal(fs.readFileSync(path.join(fx.installDir, "app.asar"), "utf8"), "old app");
    assert.equal(fs.readFileSync(fx.profile, "utf8"), "user settings");
    assert.equal(fs.existsSync(path.join(fx.job.tempRoot, "previous-install")), false);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("Windows startup failure restores the previous application after the new binary was launched", async () => {
  const fx = fixture();
  const launched = [];
  try {
    await assert.rejects(
      runWindowsUpdateTransaction(fx.job, {
        runInstaller: () => {
          fs.writeFileSync(fx.target, "new launcher");
          fs.writeFileSync(path.join(fx.installDir, "app.asar"), "new app");
        },
        launch: (target) => launched.push(target),
        waitForReadiness: async () => { throw new Error("injected startup failure"); },
      }),
      /injected startup failure/,
    );
    assert.deepEqual(launched, [fx.target]);
    assert.equal(fs.readFileSync(fx.target, "utf8"), "old launcher");
    assert.equal(fs.readFileSync(path.join(fx.installDir, "app.asar"), "utf8"), "old app");
    assert.equal(fs.readFileSync(fx.profile, "utf8"), "user settings");
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("Windows backup is removed only after functional startup succeeds", async () => {
  const fx = fixture();
  let backupExistedDuringReadiness = false;
  try {
    const result = await runWindowsUpdateTransaction(fx.job, {
      runInstaller: () => fs.writeFileSync(fx.target, "new launcher"),
      launch: () => {},
      waitForReadiness: async () => {
        backupExistedDuringReadiness = fs.existsSync(path.join(fx.job.tempRoot, "previous-install"));
        return { startup: { status: "ready" } };
      },
    });
    assert.equal(result.startup.status, "ready");
    assert.equal(backupExistedDuringReadiness, true);
    assert.equal(fs.readFileSync(fx.target, "utf8"), "new launcher");
    assert.equal(fs.existsSync(path.join(fx.job.tempRoot, "previous-install")), false);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});
