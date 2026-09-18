const fs = require("node:fs");
const path = require("node:path");

function existingInstallDirectory(job) {
  for (const candidate of [job.target, job.fallbackTarget]) {
    if (candidate && path.isAbsolute(candidate) && fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) {
      return path.dirname(candidate);
    }
  }
  throw new Error("The currently installed Feno Bridge application could not be backed up");
}

function copyDirectory(source, destination) {
  fs.cpSync(source, destination, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
}

function restoreApplicationDirectory({ backupDir, previousDir, targetDir }) {
  if (targetDir !== previousDir && fs.existsSync(targetDir)) {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
  if (fs.existsSync(previousDir)) fs.rmSync(previousDir, { recursive: true, force: true });
  copyDirectory(backupDir, previousDir);
}

async function runWindowsUpdateTransaction(job, {
  runInstaller,
  launch,
  waitForReadiness,
  onInstalled = () => {},
  appendLog = () => {},
} = {}) {
  if (typeof runInstaller !== "function" || typeof launch !== "function" || typeof waitForReadiness !== "function") {
    throw new Error("Windows update transaction requires installer, launch, and readiness functions");
  }
  const previousDir = existingInstallDirectory(job);
  const targetDir = path.dirname(job.target);
  const backupDir = path.join(job.tempRoot, "previous-install");
  if (fs.existsSync(backupDir)) throw new Error(`Update backup path already exists: ${backupDir}`);
  try {
    copyDirectory(previousDir, backupDir);
  } catch (error) {
    try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch {}
    throw new Error(`Could not back up the current Feno Bridge installation: ${error instanceof Error ? error.message : String(error)}`);
  }

  const startedAt = Date.now();
  let launchedUpdatedApplication = false;
  try {
    await runInstaller();
    if (!fs.statSync(job.target, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Installed Windows launcher is missing: ${job.target}`);
    }
    appendLog(`installer finished; waiting for Feno Bridge v${job.version} functional startup`);
    onInstalled();
    launch(job.target);
    launchedUpdatedApplication = true;
    const readiness = await waitForReadiness(job.readyPath, job.version, startedAt);
    fs.rmSync(backupDir, { recursive: true, force: true });
    return readiness;
  } catch (error) {
    if (launchedUpdatedApplication) {
      const message = error instanceof Error ? error.message : String(error);
      const retained = new Error(
        `${message}; automatic rollback was skipped because the updated application had already been launched; backup retained at ${backupDir}`,
      );
      retained.rollbackSkipped = true;
      retained.backupPath = backupDir;
      throw retained;
    }
    try {
      restoreApplicationDirectory({ backupDir, previousDir, targetDir });
      fs.rmSync(backupDir, { recursive: true, force: true });
    } catch (rollbackError) {
      const message = error instanceof Error ? error.message : String(error);
      const recovery = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      const combined = new Error(`${message}; restoring the previous installation failed: ${recovery}; backup retained at ${backupDir}`);
      combined.rollbackFailed = true;
      combined.backupPath = backupDir;
      throw combined;
    }
    if (error && typeof error === "object") error.rollbackRestored = true;
    throw error;
  }
}

module.exports = {
  existingInstallDirectory,
  restoreApplicationDirectory,
  runWindowsUpdateTransaction,
};
