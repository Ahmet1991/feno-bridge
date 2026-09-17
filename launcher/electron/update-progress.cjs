const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const MESSAGES = {
  installing: "Feno Bridge güncelleniyor. Bu işlem birkaç dakika sürebilir; başka kurulum başlatmayın. / Installing update; please do not start another installer.",
  opening: "Kurulum tamamlandı; Feno Bridge açılıyor. Lütfen bekleyin. / Installation finished; waiting for Feno Bridge to open.",
};

function startWindowsUpdateProgress(root, { spawnProcess = spawn, onError = () => {} } = {}) {
  let window = null;
  const show = (phase) => {
    try { window?.kill(); } catch {}
    window = null;
    try {
      const scriptPath = path.join(root, `update-${phase}.vbs`);
      const text = `Set shell = CreateObject("WScript.Shell")\r\nshell.Popup "${MESSAGES[phase]}", 900, "Feno Bridge", 64\r\n`;
      fs.writeFileSync(scriptPath, Buffer.from(`\uFEFF${text}`, "utf16le"), { mode: 0o600 });
      window = spawnProcess("wscript.exe", [scriptPath], { stdio: "ignore", windowsHide: false });
      window.on?.("error", onError);
      window.unref?.();
    } catch (error) {
      onError(error);
    }
  };
  show("installing");
  return {
    setPhase(phase) {
      if (!Object.hasOwn(MESSAGES, phase)) throw new Error(`Unknown update phase: ${phase}`);
      show(phase);
    },
    stop() {
      try { window?.kill(); } catch {}
      window = null;
    },
  };
}

function showWindowsUpdateFailure(root, { logPath, spawnProcess = spawn, onError = () => {} } = {}) {
  try {
    const scriptPath = path.join(root, "update-failed.vbs");
    const message = `Feno Bridge güncellemesi tamamlanamadı. Uygulama yeniden açılmaya çalışılıyor. Tanı kaydı: ${logPath || "update-worker.log"} / Update failed; attempting to reopen the app.`;
    const text = `Set shell = CreateObject("WScript.Shell")\r\nshell.Popup "${message.replaceAll('"', '""')}", 120, "Feno Bridge", 48\r\n`;
    fs.writeFileSync(scriptPath, Buffer.from(`\uFEFF${text}`, "utf16le"), { mode: 0o600 });
    const window = spawnProcess("wscript.exe", [scriptPath], { stdio: "ignore", windowsHide: false });
    window.on?.("error", onError);
    window.unref?.();
  } catch (error) {
    onError(error);
  }
}

module.exports = { startWindowsUpdateProgress, showWindowsUpdateFailure };
