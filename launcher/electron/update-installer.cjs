const { spawn, spawnSync } = require("node:child_process");

// 28.09: Windows entered modern standby a minute into an unattended install, because the launcher
// that had been blocking sleep quit for the update. The frozen installer was killed on wake by a
// wall-clock timeout that had counted 95 minutes of sleep, only its parent process died, and the
// rollback that followed found the install directory still held and left Feno Bridge uninstalled.
// So: keep the machine awake while installing, count only awake time, and end the whole tree.

const INSTALLER_AWAKE_TIMEOUT_MS = 15 * 60_000;
const TICK_MS = 1_000;
// A tick that arrives this many ticks late measured a suspension, not installer work.
const SUSPENSION_TICKS = 10;

/**
 * Hold ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED from a hidden PowerShell for as long
 * as its stdin stays open. The state belongs to that process, so it clears by itself if this
 * worker dies. Best effort: an install still runs when it cannot be held.
 */
function holdWindowsAwake({ spawnProcess = spawn } = {}) {
  // `int`, not `uint`: Windows PowerShell 5.1 reads 0x80000003 as a negative Int32 and refuses to
  // convert it to UInt32, so a `uint` signature fails silently and holds nothing (measured 28.09).
  const script = "Add-Type -Namespace Feno -Name Power -MemberDefinition "
    + "'[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(int flags);'; "
    + "[void][Feno.Power]::SetThreadExecutionState(0x80000003); [void][Console]::In.ReadToEnd()";
  let child;
  try {
    child = spawnProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    });
    child.on("error", () => {});
  } catch {
    return () => {};
  }
  return () => {
    try { child.stdin.end(); } catch {}
    const reaper = setTimeout(() => { try { child.kill(); } catch {} }, 2_000);
    reaper.unref?.();
  };
}

function killProcessTree(pid) {
  if (!Number.isInteger(pid)) return;
  spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 30_000 });
}

/** Run the NSIS installer silently; only time the machine spent awake counts toward the timeout. */
function runWindowsInstaller(source, {
  timeoutMs = INSTALLER_AWAKE_TIMEOUT_MS,
  tickMs = TICK_MS,
  now = Date.now,
  spawnInstaller = (file, args) => spawn(file, args, { stdio: "ignore", windowsHide: true }),
  killTree = killProcessTree,
} = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnInstaller(source, ["/S"]);
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    let awakeMs = 0;
    let last = now();
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setInterval(() => {
      const current = now();
      const elapsed = current - last;
      last = current;
      if (elapsed >= 0 && elapsed < tickMs * SUSPENSION_TICKS) awakeMs += elapsed;
      if (awakeMs < timeoutMs) return;
      killTree(child.pid);
      finish(new Error(`Windows installer did not finish within ${Math.round(timeoutMs / 60_000)} minutes of awake time`));
    }, tickMs);
    child.on("error", (error) => finish(error));
    child.on("exit", (code) => finish(code === 0 ? undefined : new Error(`Windows installer exited with code ${code}`)));
  });
}

module.exports = {
  holdWindowsAwake,
  killProcessTree,
  runWindowsInstaller,
};
