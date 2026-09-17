const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { waitForFunctionalReadyMarker } = require("./update-ready.cjs");
const { runWindowsUpdateTransaction } = require("./update-recovery.cjs");
const { startWindowsUpdateProgress, showWindowsUpdateFailure } = require("./update-progress.cjs");

function appendLog(job, message) {
  try {
    fs.mkdirSync(path.dirname(job.logPath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(job.logPath, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
  } catch {}
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitForParent(pid, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (processAlive(pid)) {
    if (Date.now() >= deadline) throw new Error(`Launcher process ${pid} did not exit in time`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function launch(bin, args = []) {
  const child = spawn(bin, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => {});
  child.unref();
}

function requireFile(filePath, label) {
  if (!filePath || !path.isAbsolute(filePath) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`${label} is missing: ${filePath || "unknown"}`);
  }
}

function rollbackFailure(error, rollbackError, backupPath) {
  const primary = error instanceof Error ? error.message : String(error);
  const recovery = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
  const combined = new Error(`${primary}; restoring the previous installation failed: ${recovery}; backup retained at ${backupPath}`);
  combined.rollbackFailed = true;
  combined.backupPath = backupPath;
  return combined;
}

async function updateMac(job) {
  const sourceExecutable = path.join(job.source, "Contents", "MacOS", "Feno Bridge");
  requireFile(sourceExecutable, "Staged macOS launcher");
  const startedAt = Date.now();
  const next = `${job.target}.updating-${process.pid}`;
  const previous = `${job.target}.swap-${process.pid}`;
  fs.rmSync(next, { recursive: true, force: true });
  fs.rmSync(previous, { recursive: true, force: true });
  const copied = spawnSync("/usr/bin/ditto", [job.source, next], { encoding: "utf8", timeout: 180_000 });
  if (copied.error) throw copied.error;
  if (copied.status !== 0) throw new Error(`Could not stage the macOS application: ${copied.stderr.trim()}`);
  requireFile(path.join(next, "Contents", "MacOS", "Feno Bridge"), "Copied macOS launcher");

  fs.renameSync(job.target, previous);
  try {
    fs.renameSync(next, job.target);
    launch("/usr/bin/open", [job.target]);
    const readiness = await waitForFunctionalReadyMarker(job.readyPath, job.version, startedAt);
    appendLog(job, `startup readiness confirmed: ${readiness.startup.status}`);
    fs.rmSync(previous, { recursive: true, force: true });
  } catch (error) {
    try {
      if (fs.existsSync(job.target)) fs.rmSync(job.target, { recursive: true, force: true });
      if (fs.existsSync(previous)) fs.renameSync(previous, job.target);
    } catch (rollbackError) {
      throw rollbackFailure(error, rollbackError, previous);
    }
    if (error && typeof error === "object") error.rollbackRestored = true;
    throw error;
  } finally {
    if (fs.existsSync(next)) fs.rmSync(next, { recursive: true, force: true });
  }
}

async function updateWindows(job, onInstalled = () => {}) {
  requireFile(job.source, "Windows installer");
  const readiness = await runWindowsUpdateTransaction(job, {
    runInstaller: () => {
      const result = spawnSync(job.source, ["/S"], { encoding: "utf8", timeout: 15 * 60_000, windowsHide: true });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`Windows installer exited with code ${result.status}`);
    },
    launch,
    waitForReadiness: waitForFunctionalReadyMarker,
    onInstalled,
    appendLog: (message) => appendLog(job, message),
  });
  appendLog(job, `startup readiness confirmed: ${readiness.startup.status}`);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function installLinuxFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const next = `${target}.updating-${process.pid}`;
  fs.rmSync(next, { force: true });
  fs.copyFileSync(source, next);
  fs.chmodSync(next, 0o755);
  fs.renameSync(next, target);
}

async function updateLinux(job) {
  requireFile(job.source, "Linux AppImage");
  requireFile(job.runnerSource, "Linux AppImage runner");
  const wrapper = job.wrapper && path.isAbsolute(job.wrapper) ? job.wrapper : null;
  if (!wrapper) throw new Error("Linux update job requires an absolute stable launcher wrapper");
  const startedAt = Date.now();
  const versionsRoot = path.dirname(path.dirname(job.target));
  const nextTarget = path.join(versionsRoot, job.version, path.basename(job.target));
  const runner = path.join(versionsRoot, "run-appimage");
  const wrapperBackup = path.join(job.tempRoot, "previous-linux-wrapper");
  const runnerBackup = path.join(job.tempRoot, "previous-linux-runner");
  fs.copyFileSync(wrapper, wrapperBackup);
  const runnerExisted = fs.statSync(runner, { throwIfNoEntry: false })?.isFile() === true;
  if (runnerExisted) fs.copyFileSync(runner, runnerBackup);
  try {
    installLinuxFile(job.source, nextTarget);
    installLinuxFile(job.runnerSource, runner);
    const wrapperNext = `${wrapper}.updating-${process.pid}`;
    fs.writeFileSync(wrapperNext, [
      "#!/bin/sh",
      "set -eu",
      `export CODEX_WEB_GPT_LAUNCHER_EXECUTABLE=${shellQuote(wrapper)}`,
      `export CODEX_WEB_GPT_APPIMAGE=${shellQuote(nextTarget)}`,
      `exec ${shellQuote(runner)} ${shellQuote(nextTarget)} "$@"`,
      "",
    ].join("\n"), { mode: 0o755 });
    fs.renameSync(wrapperNext, wrapper);
    launch(wrapper);
    const readiness = await waitForFunctionalReadyMarker(job.readyPath, job.version, startedAt);
    appendLog(job, `startup readiness confirmed: ${readiness.startup.status}`);
    if (path.dirname(job.target) !== path.dirname(nextTarget)
      && path.dirname(path.dirname(job.target)) === versionsRoot) {
      fs.rmSync(path.dirname(job.target), { recursive: true, force: true });
    }
    fs.rmSync(wrapperBackup, { force: true });
    fs.rmSync(runnerBackup, { force: true });
  } catch (error) {
    try {
      fs.copyFileSync(wrapperBackup, wrapper);
      fs.chmodSync(wrapper, 0o755);
      if (runnerExisted) {
        fs.copyFileSync(runnerBackup, runner);
        fs.chmodSync(runner, 0o755);
      } else {
        fs.rmSync(runner, { force: true });
      }
      if (path.dirname(nextTarget) !== path.dirname(job.target)) {
        fs.rmSync(path.dirname(nextTarget), { recursive: true, force: true });
      }
      fs.rmSync(wrapperBackup, { force: true });
      fs.rmSync(runnerBackup, { force: true });
    } catch (rollbackError) {
      throw rollbackFailure(error, rollbackError, wrapperBackup);
    }
    if (error && typeof error === "object") error.rollbackRestored = true;
    throw error;
  }
}

function relaunchExisting(job) {
  try {
    if (job.platform === "darwin" && fs.existsSync(job.target)) launch("/usr/bin/open", [job.target]);
    else if (job.platform === "win32") {
      const target = fs.existsSync(job.target)
        ? job.target
        : (job.fallbackTarget && fs.existsSync(job.fallbackTarget) ? job.fallbackTarget : null);
      if (target) launch(target);
    }
    else if (job.platform === "linux") {
      const target = job.wrapper && fs.existsSync(job.wrapper) ? job.wrapper : job.target;
      if (fs.existsSync(target)) launch(target);
    }
  } catch {}
}

async function main() {
  const jobPath = process.argv[2];
  if (!jobPath || !path.isAbsolute(jobPath)) throw new Error("Update worker requires an absolute job path");
  const job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
  appendLog(job, `waiting for launcher PID ${job.parentPid} before installing v${job.version}`);
  await waitForParent(job.parentPid);
  appendLog(job, `installing v${job.version} on ${job.platform}`);
  const progress = job.platform === "win32"
    ? startWindowsUpdateProgress(job.tempRoot, {
      onError: (error) => appendLog(job, `update status window unavailable: ${error.message}`),
    })
    : null;
  try {
    if (job.platform === "darwin") await updateMac(job);
    else if (job.platform === "win32") await updateWindows(job, () => progress?.setPhase("opening"));
    else if (job.platform === "linux") await updateLinux(job);
    else throw new Error(`Unsupported update platform: ${job.platform}`);
    appendLog(job, `v${job.version} installed and relaunched`);
    progress?.stop();
    try { fs.rmSync(job.tempRoot, { recursive: true, force: true }); } catch {}
  } catch (error) {
    appendLog(job, `update failed: ${error instanceof Error ? error.stack || error.message : String(error)}`);
    progress?.stop();
    if (!error?.rollbackFailed) relaunchExisting(job);
    else appendLog(job, `automatic relaunch skipped because rollback failed; recovery backup: ${error.backupPath || "unknown"}`);
    if (job.platform === "win32") showWindowsUpdateFailure(job.tempRoot, {
      logPath: job.logPath,
      onError: (statusError) => appendLog(job, `update failure window unavailable: ${statusError.message}`),
    });
    throw error;
  } finally {
    progress?.stop();
  }
}

void main().catch(() => process.exit(1));
