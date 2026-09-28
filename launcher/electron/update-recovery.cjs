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

// A killed installer and the old uninstaller it started can hold the install directory for a while
// after the kill. 28.09: the rollback's single rm hit EBUSY and left Feno Bridge uninstalled.
const REMOVE_RETRIES = { maxRetries: 12, retryDelay: 1_000 };

function restoreApplicationDirectory({ backupDir, previousDir, targetDir, removeDirectory = fs.rmSync }) {
  if (targetDir !== previousDir && fs.existsSync(targetDir)) {
    removeDirectory(targetDir, { recursive: true, force: true, ...REMOVE_RETRIES });
  }
  if (fs.existsSync(previousDir)) {
    try {
      removeDirectory(previousDir, { recursive: true, force: true, ...REMOVE_RETRIES });
    } catch (error) {
      // The directory itself can stay locked after everything in it is gone (another process's
      // working directory); restoring into it empty is as good as recreating it.
      if (!fs.existsSync(previousDir) || fs.readdirSync(previousDir).length > 0) throw error;
      fs.cpSync(backupDir, previousDir, { recursive: true, force: true });
      return;
    }
  }
  copyDirectory(backupDir, previousDir);
}

async function runWindowsUpdateTransaction(job, {
  runInstaller,
  launch,
  waitForReadiness,
  onInstalled = () => {},
  appendLog = () => {},
  removeDirectory = fs.rmSync,
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
      restoreApplicationDirectory({ backupDir, previousDir, targetDir, removeDirectory });
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
