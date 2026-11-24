const { configureWindowsTrust } = require("./windows-trust.cjs");
const PROCESS_STARTED_AT=Date.now()-Math.round(process.uptime()*1000);
const languages = require("./languages.json");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  powerMonitor,
  safeStorage,
  screen,
  session,
  shell,
  Tray,
} = require("electron");
const { DEVELOPMENT_PROFILE, migrateLegacyLauncherUserData, resolveLauncherProfile } = require("./profile.cjs");
const { createLogger, exportSanitizedLogs, installProcessDiagnosticGuards, registerLoggedIpc } = require("./logging.cjs");
const LAUNCHER_PROFILE = resolveLauncherProfile({ appData: app.getPath("appData") });
const IS_DEV_PROFILE = LAUNCHER_PROFILE.kind === DEVELOPMENT_PROFILE;
if (process.argv.includes("--launcher-smoke-test")) {
  const marker = process.env.CODEX_WEB_GPT_SMOKE_FILE;
  const scratch = marker && path.dirname(marker);
  const isolated = scratch && path.isAbsolute(scratch) && !IS_DEV_PROFILE
    && path.basename(scratch).startsWith("codex-web-gpt-package-smoke-")
    && LAUNCHER_PROFILE.legacyUserData === null
    && LAUNCHER_PROFILE.coreHome === path.join(scratch, "core-home")
    && LAUNCHER_PROFILE.userData === path.join(scratch, "launcher-data")
    && LAUNCHER_PROFILE.codexHome === path.join(scratch, "codex-home")
    && process.env.FENO_PC_COORDINATION_DIR === path.join(scratch, "coordination")
    && process.env.CODEX_WEB_GPT_DEV_HOME === path.join(scratch, "dev-home");
  if (!isolated) throw new Error("Packaged smoke requires an isolated launcher profile");
}
const {createBootReporter,browserInitializationAttempts}=require('./startup-timing.cjs');
// Put the first event in the directory migration will carry to the new location.
const bootLogHome=!fs.existsSync(LAUNCHER_PROFILE.userData)&&LAUNCHER_PROFILE.legacyUserData&&fs.existsSync(LAUNCHER_PROFILE.legacyUserData)
  ?LAUNCHER_PROFILE.legacyUserData:LAUNCHER_PROFILE.userData;
let bootLogger=createLogger({filePath:path.join(bootLogHome,'logs','launcher.jsonl')});
const bootReporter=createBootReporter({info:(...args)=>bootLogger.info(...args)},{processStartedAt:PROCESS_STARTED_AT});
const trustDone=bootReporter.begin('windows_trust');
configureWindowsTrust();
trustDone();
const importsDone=bootReporter.begin('application_imports');
const { BrowserHost, browserOperationBlockMessage, navigationErrorForLog } = require("./browser-host.cjs");
const { BrowserControlServer } = require("./control-server.cjs");
const { createPcLauncherService, registerPcIpc } = require("./pc-service.cjs");
const { chromeDirectory } = require("./chrome-broker.cjs");
const { getAutostart, setAutostart } = require("./autostart.cjs");
const {
  syncBundledGuidance,
  syncGlobalRouting,
  syncCliTools,
  syncCliToolsRouting,
  syncRoundTripsRouting,
} = require("./guidance.cjs");
const { RuntimeHost } = require("./runtime.cjs");
const {
  ensurePackagedRuntimeAsync,
  createRuntimeReceipt,
  inspectRuntimeMetadata,
  inspectRuntimeSource,
  pruneRuntimeVersions,
  RUNTIME_SOURCE_NOT_READY,
  waitForPackagedRuntimeSource,
} = require("./runtime-install.cjs");
const { RuntimeSupervisor } = require("./runtime-supervisor.cjs");
const { retryRuntimeStartup } = require("./runtime-startup-retry.cjs");
const { runtimeBundlePaths } = require("./runtime-command.cjs");
const { createUpdateController, waitForQuietRuntime } = require("./update.cjs");
const { writeReadyMarker } = require("./update-ready.cjs");
const {
  createStateStore,
  nextSessionRefreshReminderAt,
  validateSidebarState,
} = require("./state.cjs");
const {
  MIN_WINDOW_BOUNDS,
  readWindowState,
  trackWindowState,
} = require("./window-state.cjs");
importsDone();

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const SOURCE_ROOT = path.resolve(__dirname, "../..");
const CORE_HOME = LAUNCHER_PROFILE.coreHome;
const BROWSER_DESCRIPTOR_PATH = path.join(CORE_HOME, "runtime", "launcher-browser.json");
const BROWSER_HELPER_PATH = app.isPackaged
  ? path.join(process.resourcesPath, "runtime", "app", "browser-helper.cjs")
  : path.join(SOURCE_ROOT, ".launcher-runtime", "browser-helper.cjs");
// In the packaged launcher both helper files live in versioned application resources;
// the separately installed Bun runtime is intentionally excluded from helper lookup.
if (app.isPackaged) {
  process.env.FENO_PC_HELPER_ROOT = path.join(process.resourcesPath, "runtime", "runtime");
} else {
  delete process.env.FENO_PC_HELPER_ROOT;
}
const GITHUB_URL = "https://github.com/Ahmet1991/feno-bridge";
const X_URL = "https://x.com/miu21590";
const CONNECTORS_URL = "https://chatgpt.com/#settings/Plugins";
const TUNNELS_URL = "https://platform.openai.com/settings/organization/tunnels";
const KEYS_URL = "https://platform.openai.com/settings/organization/api-keys";
const ALLOWED_EXTERNAL_URLS = new Set([GITHUB_URL, X_URL, CONNECTORS_URL, TUNNELS_URL, KEYS_URL]);
const PACKAGED_RENDERER_URL = pathToFileURL(path.join(__dirname, "..", "dist", "index.html")).href;
const APP_ICON_PATH = path.join(__dirname, "..", "assets", "icon.png");

const launchEnvironment = {
  CODEX_CHATGPT_WEB_HOME: process.env.CODEX_CHATGPT_WEB_HOME,
  CODEX_HOME: process.env.CODEX_HOME,
};
process.env.CODEX_CHATGPT_WEB_HOME = CORE_HOME;
process.env.CODEX_HOME = LAUNCHER_PROFILE.codexHome;
app.setName(LAUNCHER_PROFILE.displayName);
if (process.platform === "win32") {
  app.setAppUserModelId(IS_DEV_PROFILE ? "dev.codexwebgpt.launcher.dev" : "dev.codexwebgpt.launcher");
}
const migrationDone=bootReporter.begin('user_data_migration');
const launcherUserData = !IS_DEV_PROFILE && LAUNCHER_PROFILE.legacyUserData
  ? migrateLegacyLauncherUserData({
      legacyPath: LAUNCHER_PROFILE.legacyUserData,
      targetPath: LAUNCHER_PROFILE.userData,
    })
  : LAUNCHER_PROFILE.userData;
fs.mkdirSync(launcherUserData, { recursive: true, mode: 0o700 });
if (process.platform !== "win32") fs.chmodSync(launcherUserData, 0o700);
app.setPath("userData", launcherUserData);
app.setAppLogsPath(path.join(launcherUserData, "logs"));
bootLogger=createLogger({filePath:path.join(launcherUserData,'logs','launcher.jsonl')});
installProcessDiagnosticGuards({
  filePath: path.join(launcherUserData, "logs", "process-stream-errors.log"),
});
migrationDone();

let mainWindow = null;
let mainWindowReadyToShow = false;
let mainWindowShowRequested = false;
let startupFailed = false;
let startupFailureTransient = false;
let browserHost = null;
let runtimeHost = null;
// Renderer actions can arrive as soon as loadRenderer starts, before startup has acquired any
// runtime operation lock. Keep setup/settings behind startup and its recovery as one boundary.
let finishRuntimeStartup;
const runtimeStartup = new Promise(resolve => { finishRuntimeStartup = resolve; });
let browserControl = null;
let runtimeSupervisor = null;
let tray = null;
let quitting = false;
let shutdownInProgress = false;
let exitCommitted = false;
let smokePassedThisSession = false;
let cdpPort = 0;
let lastOperation = null;
let catalogVerificationTimer = null;
let catalogVerificationInFlight = false;
let updateController = null;
let startupReadiness = null;
let launcherLogger = null;
let pcService = null;
let pcStartupRetry = null;
let disposeTunnelWake = null;
const runtimeStartupAbort = new AbortController();

function findFreePort() {
  // Electron consumes Chromium switches at ready, not when whenReady() is awaited.
  // The short synchronous probe lets the OS select a port without yielding the main thread.
  const result = spawnSync(process.execPath, ["-e", `
    const server = require('node:net').createServer();
    server.listen(0, '127.0.0.1', () => {
      console.log(server.address().port);
      server.close();
    });
  `], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", timeout: 10000, windowsHide: true });
  const port = Number(result.stdout?.trim());
  if (result.error || result.status !== 0 || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Unable to select launcher CDP port synchronously", { cause: result.error });
  }
  return port;
}

function send(channel, value) {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, value);
  }
}

function publishOperation(operation) {
  lastOperation = operation;
  send("launcher:operation", operation);
}

function writeLauncherReadyMarker() {
  try {
    writeReadyMarker(
      path.join(app.getPath("logs"), "launcher-ready.json"),
      app.getVersion(),
      Date.now(),
      startupReadiness,
    );
  } catch (error) {
    launcherLogger?.warn?.("launcher.ready_marker_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function recordStartupReadiness(status, detail = "") {
  startupReadiness = {
    status,
    at: Date.now(),
    ...(detail ? { detail } : {}),
  };
  writeLauncherReadyMarker();
}

function stopCatalogVerificationMonitor() {
  if (catalogVerificationTimer) clearInterval(catalogVerificationTimer);
  catalogVerificationTimer = null;
}

function startCatalogVerificationMonitor({ logger, stateStore }) {
  stopCatalogVerificationMonitor();
  let reportedFailure = null;
  const check = async () => {
    const current = stateStore.read();
    if (current.coreSetupComplete !== true || current.codexCatalogVerified === true) {
      stopCatalogVerificationMonitor();
      return;
    }
    if (current.codexRouteEnabled === false) {
      // Codex is not routed through Feno, so there is no Codex catalog request to wait for.
      send("launcher:state-changed", stateStore.update({ codexCatalogVerified: true }));
      stopCatalogVerificationMonitor();
      return;
    }
    if (catalogVerificationInFlight || !runtimeSupervisor) return;
    catalogVerificationInFlight = true;
    try {
      const config = runtimeSupervisor.readConfig();
      const health = await runtimeSupervisor.proxyHealthPayload(config);
      if (!Number.isInteger(health?.successful_model_catalog_requests)
        || health.successful_model_catalog_requests < 1) {
        const result = health?.last_model_catalog_result;
        if (!result
          || !Number.isInteger(result.status)
          || result.status < 400
          || result.status > 599
          || !Number.isInteger(result.request)
          || result.request < 1
          || lastOperation?.status === "running") return;
        const identity = `${health.pid}:${result.request}:${result.at}`;
        if (identity === reportedFailure) return;
        reportedFailure = identity;
        const reason = typeof result.failure?.code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(result.failure.code)
          ? result.failure.code
          : ["config", "request", "transport", "upstream", "catalog"].includes(result.failure?.stage)
            ? result.failure.stage
            : "catalog";
        const state = stateStore.update({ codexRestartRequired: false });
        send("launcher:state-changed", state);
        logger.warn("codex.model_catalog_failed", {
          status: result.status,
          reason,
          request: result.request,
        });
        publishOperation({
          name: "catalog-verification",
          status: "failed",
          message: nativeCopyFor(current.language).catalogFailure
            .replace("{status}", String(result.status))
            .replace("{reason}", reason),
        });
        return;
      }
      const state = stateStore.update({
        codexCatalogVerified: true,
        codexRestartRequired: false,
      });
      logger.info("codex.model_catalog_verified", {
        requests: health.successful_model_catalog_requests,
        at: health.last_successful_model_catalog_request_at,
      });
      send("launcher:state-changed", state);
      stopCatalogVerificationMonitor();
    } catch (error) {
      logger.debug("codex.model_catalog_verification_pending", {
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      catalogVerificationInFlight = false;
    }
  };
  catalogVerificationTimer = setInterval(() => { void check(); }, 2_000);
  catalogVerificationTimer.unref?.();
  void check();
}

async function restoreCodexRouteAfterRuntimeFailure({ logger, stateStore }) {
  try {
    const route = await runtimeHost.restoreBridgeRoute("runtime-start-fail-safe");
    if (!route.installed || route.active) return { restored: false };
    const state = stateStore.update({
      codexCatalogVerified: false,
      codexRestartRequired: true,
    });
    send("launcher:state-changed", state);
    stopCatalogVerificationMonitor();
    logger.warn("bridge.route_restored_after_runtime_failure", {
      changed: route.changed === true,
    });
    return { restored: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("bridge.route_restore_after_runtime_failure_failed", { message });
    return { restored: false, error: message };
  }
}

function trayImage() {
  if (process.platform !== "darwin") {
    return nativeImage.createFromPath(APP_ICON_PATH).resize({ width: 18, height: 18 });
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18"><path d="M4.1 3.4h6.4l3.4 3.4v7.8H7.5l-3.4-3.4V3.4Z" fill="none" stroke="white" stroke-width="1.5" stroke-linejoin="round"/><path d="m7 7 2-2 2 2M7 11l2 2 2-2" fill="none" stroke="white" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const image = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
  image.setTemplateImage(true);
  return image;
}

const NATIVE_COPY = Object.freeze({
  en: Object.freeze({
    openLauncher: "Open Feno Bridge",
    quit: "Quit",
    exportDiagnostics: "Export privacy-safe diagnostics",
    cancel: "Cancel",
    remove: "Remove",
    removeTitle: "Remove Feno Bridge",
    removeMessage: "Remove the ChatGPT Web models from Codex and restore the previous model route?",
    removeDetail: "The launcher's ChatGPT login profile will be preserved. Codex must be restarted once.",
    retry: "Retry",
    startupTitle: "Feno Bridge could not start",
    startupDetail: "Retry starts Feno Bridge again without changing your saved settings or ChatGPT profile.",
    startupCleanupFailed: "Startup cleanup failed",
    catalogFailure: "Codex reached Feno Bridge, but loading its model catalog failed (HTTP {status}; {reason}). Check Activity for details and export a privacy-safe log if it persists.",
    updateNow: "Update now",
    updateTitle: "Update Feno Bridge",
    updateMessage: "Feno Bridge will close while the update installs. Reopening may take several minutes.",
    updateDetail: "On Windows, an update status window will stay open. Do not start another installer while it is running. Active Codex tasks may be interrupted.",
    updateSignInRequired: "Sign in to ChatGPT before updating. The update checks the ChatGPT session and would otherwise leave Feno Bridge needing a repair.",
  }),
  "zh-CN": Object.freeze({
    openLauncher: "打开 Feno Bridge",
    quit: "退出",
    exportDiagnostics: "导出隐私安全诊断",
    cancel: "取消",
    remove: "移除",
    removeTitle: "移除 Feno Bridge",
    removeMessage: "从 Codex 中移除 ChatGPT Web 模型并恢复此前的模型路由？",
    removeDetail: "Feno Bridge 中的 ChatGPT 登录 profile 会保留。Codex 需要重启一次。",
    retry: "重试",
    startupTitle: "Feno Bridge 无法启动",
    startupDetail: "重试会重新启动 Feno Bridge，不会更改已保存的设置或 ChatGPT 登录配置。",
    startupCleanupFailed: "启动清理失败",
    catalogFailure: "Codex 已连接到 Feno Bridge，但模型列表加载失败（HTTP {status}；{reason}）。请查看“活动”了解详情；若问题持续，请导出安全日志。",
    updateNow: "立即更新",
    updateTitle: "更新 Feno Bridge",
    updateMessage: "安装更新时 Feno Bridge 将关闭，重新打开可能需要几分钟。",
    updateDetail: "在 Windows 上会保持一个单独的更新状态窗口。运行期间不要启动其他安装程序。活动中的 Codex 任务可能会中断。",
    updateSignInRequired: "更新前请先登录 ChatGPT。更新会验证 ChatGPT 会话，否则 Feno Bridge 将需要修复。",
  }),
  "zh-TW": Object.freeze({
    openLauncher: "開啟 Feno Bridge",
    quit: "結束",
    exportDiagnostics: "匯出隱私安全診斷",
    cancel: "取消",
    remove: "移除",
    removeTitle: "移除 Feno Bridge",
    removeMessage: "從 Codex 中移除 ChatGPT Web 模型並還原先前的模型路由？",
    removeDetail: "Feno Bridge 中的 ChatGPT 登入設定檔會保留。Codex 需要重新啟動一次。",
    retry: "重試",
    startupTitle: "Feno Bridge 無法啟動",
    startupDetail: "重試會重新啟動 Feno Bridge，不會變更已儲存的設定或 ChatGPT 登入設定檔。",
    startupCleanupFailed: "啟動清理失敗",
    catalogFailure: "Codex 已連線到 Feno Bridge，但模型清單載入失敗（HTTP {status}；{reason}）。請查看「活動」了解詳情；若問題持續，請匯出安全日誌。",
    updateNow: "立即更新",
    updateTitle: "更新 Feno Bridge",
    updateMessage: "安裝更新時 Feno Bridge 將關閉，重新開啟可能需要幾分鐘。",
    updateDetail: "Windows 會保留獨立的更新狀態視窗。執行期間請勿啟動其他安裝程式。進行中的 Codex 工作可能會中斷。",
    updateSignInRequired: "更新前請先登入 ChatGPT。更新會驗證 ChatGPT 工作階段，否則 Feno Bridge 將需要修復。",
  }),
  ja: Object.freeze({
    openLauncher: "Feno Bridge を開く",
    quit: "終了",
    exportDiagnostics: "プライバシー保護済みの診断情報をエクスポート",
    cancel: "キャンセル",
    remove: "削除",
    removeTitle: "Feno Bridge を削除",
    removeMessage: "Codex から ChatGPT Web モデルを削除し、以前のモデルルートを復元しますか？",
    removeDetail: "Feno Bridge の ChatGPT ログインプロファイルは保持されます。Codex を一度再起動する必要があります。",
    retry: "再試行",
    startupTitle: "Feno Bridge を起動できませんでした",
    startupDetail: "保存済みの設定と ChatGPT プロファイルを変更せずに Feno Bridge を再起動します。",
    startupCleanupFailed: "起動後のクリーンアップに失敗しました",
    catalogFailure: "Codex は Feno Bridge に接続しましたが、モデル一覧を読み込めませんでした（HTTP {status}、{reason}）。「アクティビティ」で詳細を確認し、問題が続く場合は安全なログをエクスポートしてください。",
    updateNow: "今すぐ更新",
    updateTitle: "Feno Bridge を更新",
    updateMessage: "更新のインストール中は Feno Bridge が終了します。再起動には数分かかる場合があります。",
    updateDetail: "Windows では更新状況ウィンドウが開いたままになります。実行中に別のインストーラーを起動しないでください。実行中の Codex タスクが中断される場合があります。",
    updateSignInRequired: "更新する前に ChatGPT にサインインしてください。更新では ChatGPT セッションを確認するため、サインインしていないと Feno Bridge の修復が必要になります。",
  }),
  ko: Object.freeze({
    openLauncher: "Feno Bridge 열기",
    quit: "종료",
    exportDiagnostics: "개인정보가 보호된 진단 정보 내보내기",
    cancel: "취소",
    remove: "제거",
    removeTitle: "Feno Bridge 제거",
    removeMessage: "Codex에서 ChatGPT Web 모델을 제거하고 이전 모델 경로를 복원할까요?",
    removeDetail: "Feno Bridge의 ChatGPT 로그인 프로필은 유지됩니다. Codex를 한 번 다시 시작해야 합니다.",
    retry: "다시 시도",
    startupTitle: "Feno Bridge를 시작할 수 없습니다",
    startupDetail: "저장된 설정이나 ChatGPT 프로필을 변경하지 않고 Feno Bridge를 다시 시작합니다.",
    startupCleanupFailed: "시작 정리에 실패했습니다",
    catalogFailure: "Codex가 Feno Bridge에 연결했지만 모델 목록을 불러오지 못했습니다(HTTP {status}; {reason}). 활동에서 세부 정보를 확인하고 문제가 계속되면 안전한 로그를 내보내 주세요.",
    updateNow: "지금 업데이트",
    updateTitle: "Feno Bridge 업데이트",
    updateMessage: "업데이트를 설치하는 동안 Feno Bridge가 종료됩니다. 다시 여는 데 몇 분이 걸릴 수 있습니다.",
    updateDetail: "Windows에서는 별도의 업데이트 상태 창이 열린 상태로 유지됩니다. 실행 중에는 다른 설치 프로그램을 시작하지 마세요. 실행 중인 Codex 작업이 중단될 수 있습니다.",
    updateSignInRequired: "업데이트하기 전에 ChatGPT에 로그인하세요. 업데이트는 ChatGPT 세션을 확인하므로, 로그인하지 않으면 Feno Bridge를 복구해야 합니다.",
  }),
  tr: Object.freeze({
    openLauncher: "Feno Bridge'i aç",
    quit: "Çık",
    exportDiagnostics: "Gizliliğe uygun tanılamayı dışa aktar",
    cancel: "İptal",
    remove: "Kaldır",
    removeTitle: "Feno Bridge'i kaldır",
    removeMessage: "ChatGPT Web modelleri Codex'ten kaldırılsın ve önceki model rotası geri yüklensin mi?",
    removeDetail: "Uygulamadaki ChatGPT oturum açma profili korunacak. Codex'in bir kez yeniden başlatılması gerekir.",
    retry: "Yeniden dene",
    startupTitle: "Feno Bridge başlatılamadı",
    startupDetail: "Yeniden deneme, kayıtlı ayarlarınızı veya ChatGPT profilinizi değiştirmeden Feno Bridge'i yeniden başlatır.",
    startupCleanupFailed: "Başlangıç temizliği başarısız oldu",
    catalogFailure: "Codex, Feno Bridge'e ulaştı ancak model kataloğu yüklenemedi (HTTP {status}; {reason}). Ayrıntılar için Etkinlik bölümüne bakın; sorun sürerse gizliliğe uygun tanılamayı dışa aktarın.",
    updateNow: "Şimdi güncelle",
    updateTitle: "Feno Bridge'i güncelle",
    updateMessage: "Güncelleme sırasında Feno Bridge kapanacak. Yeniden açılması birkaç dakika sürebilir.",
    updateDetail: "Windows'ta ayrı bir güncelleme durum penceresi açık kalacak. Bu sırada başka kurulum başlatmayın. Etkin Codex görevleri kesilebilir.",
    updateSignInRequired: "Güncellemeden önce ChatGPT'ye giriş yapın. Güncelleme ChatGPT oturumunu doğrular; giriş yapılmadan kurulursa Feno Bridge onarım ister.",
  }),
});

function nativeCopyFor(language) {
  return NATIVE_COPY[language] || NATIVE_COPY.en;
}

function updateTrayMenu(language) {
  if (!tray) return;
  const copy = nativeCopyFor(language);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: copy.openLauncher, click: () => showMainWindow() },
    { type: "separator" },
    { label: copy.quit, click: () => { void requestQuit(); } },
  ]));
}

function createTray(logger, language) {
  try {
    tray = new Tray(trayImage());
    tray.setToolTip(LAUNCHER_PROFILE.displayName);
    updateTrayMenu(language);
    tray.on("click", () => showMainWindow());
    return true;
  } catch (error) {
    tray = null;
    logger.warn("launcher.tray_unavailable", { message: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

function showMainWindow() {
  // A Windows login launch may still be materializing the packaged runtime when the user opens
  // the desktop shortcut. Electron delivers `second-instance` immediately, before `createWindow`
  // has produced anything to show. Preserve that foreground request until the real window reaches
  // `ready-to-show`; otherwise the already-running `--hidden` instance silently consumes it.
  mainWindowShowRequested = true;
  if ((!mainWindowReadyToShow && !startupFailed) || !mainWindow || mainWindow.isDestroyed()) return;
  mainWindowShowRequested = false;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function relaunchAfterFailedStart() {
  // Internal child commands use the resolved profile. A fresh launcher must instead
  // resolve the original launch environment, especially for the isolated DEV profile.
  for (const [key, value] of Object.entries(launchEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  app.relaunch({ args: process.argv.slice(1).filter(argument => argument !== "--hidden") });
}

function handleSecondInstance() {
  // A launcher opened while the Windows installer was still writing the update fails with the
  // runtime not ready, then waits on its error dialog holding the single-instance lock. The
  // updater's own launch lands here once the install is complete; showing the stale error would
  // swallow it (21.11: v5.1.30 "did not become functionally ready", Feno stayed down). That
  // failure is transient, so a new launch retries it. Other failures keep their error window.
  if (startupFailed && startupFailureTransient) {
    relaunchAfterFailedStart();
    app.exit(1);
    return;
  }
  showMainWindow();
}

async function openWebUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Refusing to open a non-web URL: ${parsed.protocol}`);
  }
  await shell.openExternal(parsed.toString());
}

function rendererNavigationAllowed(value) {
  let target;
  try {
    target = new URL(value);
  } catch {
    return false;
  }
  if (isDev) {
    try {
      return target.origin === new URL(process.env.VITE_DEV_SERVER_URL).origin;
    } catch {
      return false;
    }
  }
  target.hash = "";
  target.search = "";
  return target.href === PACKAGED_RENDERER_URL;
}

function windowStateSnapshot(window) {
  return {
    fullScreen: Boolean(window && !window.isDestroyed() && window.isFullScreen()),
    maximized: Boolean(window && !window.isDestroyed() && window.isMaximized()),
  };
}

function createWindow({ logger, stateStore, windowStatePath, startHidden }) {
  const isMac = process.platform === "darwin";
  const state = stateStore.read();
  const windowState = readWindowState(windowStatePath, screen.getAllDisplays());
  const window = new BrowserWindow({
    width: windowState.bounds.width,
    height: windowState.bounds.height,
    ...(Number.isFinite(windowState.bounds.x) && Number.isFinite(windowState.bounds.y)
      ? { x: windowState.bounds.x, y: windowState.bounds.y }
      : {}),
    minWidth: MIN_WINDOW_BOUNDS.width,
    minHeight: MIN_WINDOW_BOUNDS.height,
    title: LAUNCHER_PROFILE.displayName,
    icon: APP_ICON_PATH,
    show: false,
    backgroundColor: isMac ? "#00000000" : "#181818",
    titleBarStyle: isMac ? "hiddenInset" : "hidden",
    transparent: isMac,
    ...(isMac ? {
      trafficLightPosition: { x: 16, y: 17 },
      vibrancy: "under-window",
      visualEffectState: "active",
    } : {
      titleBarOverlay: {
        color: "#181818",
        symbolColor: "#a8a8a8",
        height: 46,
      },
    }),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      v8CacheOptions: "bypassHeatCheckAndEagerCompile",
    },
  });
  window.setMenuBarVisibility(false);
  const guardRendererNavigation = (event, url) => {
    if (rendererNavigationAllowed(url)) return;
    event.preventDefault();
    let destination = "invalid URL";
    try { destination = new URL(url).origin; } catch {}
    logger.warn("launcher.renderer_navigation_blocked", { destination });
  };
  window.webContents.on("will-navigate", guardRendererNavigation);
  window.webContents.on("will-redirect", guardRendererNavigation);
  window.webContents.setWindowOpenHandler(({ url }) => {
    void openWebUrl(url).catch((error) => {
      logger.warn("launcher.external_url_rejected", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
    return { action: "deny" };
  });
  window.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    if (stateStore.read().keepRunningOnClose && tray) window.hide();
    else void requestQuit();
  });
  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
      mainWindowReadyToShow = false;
    }
  });
  window.on("show", () => {
    writeLauncherReadyMarker();
  });
  for (const event of ["enter-full-screen", "leave-full-screen", "maximize", "unmaximize"]) {
    window.on(event, () => send("launcher:window-state-changed", windowStateSnapshot(window)));
  }
  window.once("ready-to-show", () => {
    if (!state.onboardingComplete && !Number.isFinite(windowState.bounds.x)) window.center();
    if (windowState.maximized) window.maximize();
    if (windowState.fullscreen) window.setFullScreen(true);
    if (mainWindow === window) mainWindowReadyToShow = true;
    if (mainWindowShowRequested) showMainWindow();
    else if (!startHidden) window.show();
  });
  trackWindowState(window, windowStatePath, (error) => {
    logger.warn("launcher.window_state_write_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  });
  logger.info("launcher.window_created", { platform: process.platform, cdpPort });
  return window;
}

async function loadRenderer(window) {
  if (isDev) {
    await window.loadURL(process.env.VITE_DEV_SERVER_URL);
    return;
  }
  await window.loadFile(path.join(__dirname, "..", "dist", "index.html"));
}

function validateLanguage(value) {
  if (typeof value !== "string" || !Object.hasOwn(languages, value)) {
    throw new Error(`Language must be one of: ${Object.keys(languages).join(", ")}`);
  }
  return value;
}

function validateBrowserInteractionMode(value) {
  if (value !== "automatic" && value !== "manual") {
    throw new Error("Browser interaction mode must be automatic or manual");
  }
  return value;
}

function validateBounds(value) {
  if (!value || typeof value !== "object") throw new Error("Browser bounds are required");
  for (const key of ["x", "y", "width", "height"]) {
    if (!Number.isFinite(value[key])) throw new Error(`Browser bounds ${key} must be finite`);
  }
  return value;
}

function smokePassedForCurrentVersion(state) {
  return state.browserSmokePassed === true && state.browserSmokeVersion === app.getVersion();
}

function registerIpc({ logger, stateStore }) {
  registerPcIpc({
    register: (channel, handler) => registerLoggedIpc(ipcMain, logger, channel, handler),
    getMainWindow: () => mainWindow,
    rendererNavigationAllowed,
    getService: () => pcService,
    dialog,
    openChromeExtensionFolder: async () => {
      const directory=app.isPackaged?path.join(process.resourcesPath,"chrome-extension"):path.join(SOURCE_ROOT,"launcher","chrome-extension");
      if(!fs.existsSync(path.join(directory,"manifest.json")))throw Error("pc_chrome_not_connected");
      const error=await shell.openPath(directory);if(error)throw Error("pc_chrome_not_connected");
      return true;
    },
    openChromeExtensions: () => {
      const candidates=[process.env.ProgramFiles,process.env["ProgramFiles(x86)"],process.env.LOCALAPPDATA].filter(Boolean).map(root=>path.join(root,"Google","Chrome","Application","chrome.exe"));
      const exe=candidates.find(p=>fs.existsSync(p));if(!exe)throw Error("pc_chrome_not_connected");
      const child=require("node:child_process").spawn(exe,["chrome://extensions"],{detached:true,stdio:"ignore",windowsHide:true});
      child.on("error",()=>{});child.unref();return true;
    },
  });
  const runtimeChannels = new Set([
    "launcher:setup-core", "launcher:setup-mcp", "launcher:uninstall-integration",
    "launcher:bigger-context", "launcher:skill-attachments", "launcher:zero-risk-pro", "launcher:codex-route",
    "launcher:browser-interaction-mode", "launcher:mcp-verify", "launcher:doctor",
    "launcher:cancel-turns", "launcher:browser-passkey-login", "launcher:browser-logout",
    "launcher:browser-smoke", "launcher:update-install", "launcher:complete-onboarding",
  ]);
  const handle = (channel, handler) => registerLoggedIpc(ipcMain, logger, channel, async (...args) => {
    if (runtimeChannels.has(channel)) await runtimeStartup;
    return handler(...args);
  });
  handle("launcher:snapshot", async () => ({
    profile: LAUNCHER_PROFILE.kind,
    profilePaths: {
      coreHome: CORE_HOME,
      codexHome: LAUNCHER_PROFILE.codexHome,
      userData: launcherUserData,
    },
    state: stateStore.read(),
    browser: browserHost?.snapshot() ?? null,
    connectorName: runtimeHost.browserConnectorName(),
    connectorNames: {
      automatic: runtimeHost.setupConnectorName(),
      manual: "Codex Zero Risk",
    },
    mcpCredentialsConfigured: runtimeHost?.mcpCredentialsConfigured() ?? false,
    logs: logger.recent(),
    urls: { github: GITHUB_URL, x: X_URL, connectors: CONNECTORS_URL, tunnels: TUNNELS_URL, keys: KEYS_URL },
    platform: process.platform,
    packaged: app.isPackaged,
    version: app.getVersion(),
    smokePassed: smokePassedThisSession || smokePassedForCurrentVersion(stateStore.read()),
    operation: lastOperation,
    update: updateController?.getState() ?? { status: "disabled" },
  }));

  handle("launcher:set-language", (_event, language) => {
    const state = stateStore.update({ language: validateLanguage(language) });
    updateTrayMenu(state.language);
    return state;
  });
  handle("launcher:open-social", async (_event, target) => {
    const url = target === "github" ? GITHUB_URL : target === "x" ? X_URL : null;
    if (!url) throw new Error("Unknown social target");
    await openWebUrl(url);
    const patch = target === "github" ? { githubOpened: true } : { xOpened: true };
    return stateStore.update(patch);
  });
  handle("launcher:complete-onboarding", (_event, language, rawInteractionMode) => {
    const current = stateStore.read();
    if (current.autoStart) setAutostart(app, true);
    const next = stateStore.update({
      language: validateLanguage(language),
      browserInteractionMode: validateBrowserInteractionMode(rawInteractionMode),
      onboardingComplete: true,
    });
    updateTrayMenu(next.language);
    logger.info("launcher.onboarding_completed", {
      language: next.language,
      browserInteractionMode: next.browserInteractionMode,
    });
    return next;
  });

  handle("launcher:open-external", async (_event, url) => {
    if (!ALLOWED_EXTERNAL_URLS.has(url)) throw new Error("External URL is not allowlisted");
    await openWebUrl(url);
    return true;
  });

  handle("launcher:browser-bounds", (event, bounds) => {
    browserHost?.setBounds(validateBounds(bounds), event.sender.getZoomFactor());
    return true;
  });
  handle("launcher:browser-surface-active", (_event, active) => browserHost.setSurfaceActive(active === true));
  handle("launcher:browser-show", () => browserHost.reveal(
    stateStore.read().browserInteractionMode === "automatic",
  ));
  handle("launcher:browser-hide", () => { browserHost?.hide(); return browserHost?.snapshot(); });
  handle("launcher:browser-navigate", (_event, action) => browserHost.navigate(action));
  handle("launcher:browser-zoom", (_event, action) => browserHost.zoom(action));
  handle("launcher:browser-tab-select", (_event, tabId) => browserHost.selectTab(tabId));
  handle("launcher:browser-tab-close", (_event, tabId) => browserHost.closeTab(tabId));
  handle("launcher:manual-prompt-copy", (_event, tabId) => browserHost.copyManualPrompt(tabId));
  handle("launcher:manual-prompt-sent", (_event, tabId) => browserHost.confirmManualSent(tabId));
  handle("launcher:browser-login", async () => {
    const browser = await browserHost.openLogin();
    if (browser.authenticated) {
      const state = stateStore.update({ sessionRefreshReminderAt: nextSessionRefreshReminderAt() });
      send("launcher:state-changed", state);
    }
    return browser;
  });
  handle("launcher:browser-passkey-login", async () => {
    const browser = await browserHost.openPasskeyLogin();
    if (browser.authenticated) {
      const state = stateStore.update({ sessionRefreshReminderAt: nextSessionRefreshReminderAt() });
      send("launcher:state-changed", state);
    }
    return browser;
  });
  handle("launcher:browser-passkey-login-continue", () => runtimeHost.continuePasskeyLogin());
  handle("launcher:browser-logout", async () => {
    const browser = await browserHost.logout();
    const state = stateStore.update({ sessionRefreshReminderAt: nextSessionRefreshReminderAt() });
    send("launcher:state-changed", state);
    return { browser, state };
  });
  handle("launcher:session-reminder-dismiss", () => {
    const state = stateStore.update({ sessionRefreshReminderAt: nextSessionRefreshReminderAt() });
    send("launcher:state-changed", state);
    return state;
  });
  handle("launcher:browser-smoke", async () => {
    if (stateStore.read().browserInteractionMode === "manual") {
      throw new Error("Browser smoke testing is disabled in Zero Risk mode");
    }
    const result = await browserHost.smokeTest();
    stateStore.update({ browserSmokePassed: true, browserSmokeVersion: app.getVersion() });
    smokePassedThisSession = true;
    return result;
  });
  handle("launcher:mcp-verify", async (event) => {
    const operationName = "mcp-verification";
    const activeTraceId = browserHost.activeTraceId;
    logger.info("mcp.verification_requested", {
      activeTraceId,
      launcherFocused: mainWindow?.isFocused() === true,
      rendererFocused: event.sender.isFocused(),
    });
    if (activeTraceId) {
      const report = {
        ok: false,
        checks: [{
          id: "connector",
          status: "error",
          message: "Finish the active Codex task before verifying the ChatGPT connector",
          detail: `Active browser turn: ${activeTraceId}`,
        }],
      };
      const state = stateStore.update({ mcpSetupComplete: false });
      send("launcher:state-changed", state);
      publishOperation({ name: operationName, status: "failed", message: report.checks[0].message });
      return report;
    }
    publishOperation({ name: operationName, status: "running", message: "Checking local runtime" });
    const report = IS_DEV_PROFILE ? await runtimeHost.devDoctor() : await runtimeHost.doctor();
    if (!report.ok) {
      const message = report.checks
        .filter((check) => check.status === "error")
        .map((check) => check.message)
        .filter(Boolean)
        .join("; ") || "The local MCP runtime is not healthy";
      const state = stateStore.update({ mcpSetupComplete: false });
      send("launcher:state-changed", state);
      publishOperation({ name: operationName, status: "failed", message });
      return report;
    }
    if (stateStore.read().browserInteractionMode === "manual") {
      const state = stateStore.update({ mcpSetupComplete: true });
      send("launcher:state-changed", state);
      const successMessage = "Local Zero Risk runtime is healthy; connector selection remains a manual turn step";
      publishOperation({ name: operationName, status: "completed", message: successMessage });
      return {
        ...report,
        checks: [
          ...report.checks.filter((check) => check.id !== "connector"),
          {
            id: "connector",
            status: "warning",
            message: `Select ChatGPT connector ${JSON.stringify(runtimeHost.mcpConnectorName())} manually for every Zero Risk turn`,
          },
        ],
      };
    }
    try {
      publishOperation({ name: operationName, status: "running", message: "Checking ChatGPT connector" });
      await browserHost.verifyConnector(runtimeHost.mcpConnectorName());
      const state = stateStore.update({ mcpSetupComplete: true });
      send("launcher:state-changed", state);
      const successMessage = IS_DEV_PROFILE
        ? "DEV harness and connector verified"
        : "Runtime and connector verified";
      publishOperation({ name: operationName, status: "completed", message: successMessage });
      return {
        ...report,
        checks: report.checks.map((check) => check.id === "connector"
          ? {
              id: "connector",
              status: "ok",
              message: `ChatGPT connector ${JSON.stringify(runtimeHost.mcpConnectorName())} is available`,
            }
          : check),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const state = stateStore.update({ mcpSetupComplete: false });
      send("launcher:state-changed", state);
      publishOperation({ name: operationName, status: "failed", message });
      return {
        ...report,
        ok: false,
        checks: [
          ...report.checks.filter((check) => check.id !== "connector"),
          { id: "connector", status: "error", message },
        ],
      };
    }
  });

  handle("launcher:doctor", () => IS_DEV_PROFILE ? runtimeHost.devDoctor() : runtimeHost.doctor());
  handle("launcher:cancel-turns", () => {
    if (IS_DEV_PROFILE) throw new Error("DEV chat turns are owned by the repository CLI process");
    return runtimeHost.cancelActiveTurns();
  });
  handle("launcher:uninstall-integration", async () => {
    if (IS_DEV_PROFILE) throw new Error("DEV profile has no Codex integration to remove");
    const copy = nativeCopyFor(stateStore.read().language);
    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      buttons: [copy.cancel, copy.remove],
      defaultId: 0,
      cancelId: 0,
      title: copy.removeTitle,
      message: copy.removeMessage,
      detail: copy.removeDetail,
      noLink: true,
    });
    if (confirmation.response !== 1) return { cancelled: true };
    try {
      await runtimeHost.uninstallIntegration();
    } finally {
      browserHost.writeDescriptor();
    }
    const state = stateStore.update({
      coreSetupComplete: false,
      codexCatalogVerified: false,
      mcpSetupComplete: false,
      mcpRuntimeInstalled: false,
      mcpGuideStep: 0,
      codexRestartRequired: true,
      browserInteractionMode: "automatic",
      experimentalBiggerContext: false,
      experimentalSkillAttachments: false,
      zeroRiskProEnabled: false,
    });
    send("launcher:state-changed", state);
    stopCatalogVerificationMonitor();
    return { cancelled: false, state };
  });
  handle("launcher:setup-core", async () => {
    const setupState = stateStore.read();
    if (setupState.browserInteractionMode === "automatic") {
      const browser = await browserHost.probeAuthentication();
      if (!browser.authenticated) {
        if (browser.status === "error") throw new Error(browser.message);
        throw new Error(
          IS_DEV_PROFILE
            ? "Sign in to the isolated DEV ChatGPT profile before configuring the harness"
            : "Sign in to ChatGPT before installing the Codex integration",
        );
      }
    }
    if (setupState.browserInteractionMode === "automatic"
      && !setupState.coreSetupComplete
      && !(smokePassedThisSession || smokePassedForCurrentVersion(setupState))) {
      throw new Error(
        IS_DEV_PROFILE
          ? "Run the browser smoke test before configuring the DEV harness"
          : "Run the browser smoke test before installing the Codex integration",
      );
    }
    const result = IS_DEV_PROFILE ? await runtimeHost.setupDevCore() : await runtimeHost.setupCore();
    stateStore.update({
      coreSetupComplete: true,
      codexCatalogVerified: IS_DEV_PROFILE ? true : false,
      codexRestartRequired: IS_DEV_PROFILE ? false : true,
      zeroRiskProEnabled: runtimeHost.runtimeConfigSnapshot().config?.zeroRiskProEnabled === true,
      ...(result.mode === "full" ? {
        mcpRuntimeInstalled: true,
        mcpSetupComplete: false,
        mcpGuideStep: 2,
      } : {
        mcpSetupComplete: false,
        mcpRuntimeInstalled: false,
        mcpGuideStep: 0,
      }),
    });
    await browserHost.returnToIdle().catch((error) => {
      logger.warn("browser.idle_cleanup_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
    if (!IS_DEV_PROFILE) startCatalogVerificationMonitor({ logger, stateStore });
    return { ok: true, stdout: result.stdout, restartRequired: !IS_DEV_PROFILE };
  });
  handle("launcher:setup-mcp", async (_event, input) => {
    const currentMode = stateStore.read().browserInteractionMode;
    const interactionMode = input?.interactionMode === undefined
      ? currentMode
      : validateBrowserInteractionMode(input.interactionMode);
    const interactionModeChange = interactionMode !== currentMode;
    const setup = IS_DEV_PROFILE
      ? runtimeHost.setupDevMcp.bind(runtimeHost)
      : runtimeHost.setupMcp.bind(runtimeHost);
    const runSetup = afterRuntimeReady => setup({
      tunnelId: typeof input?.tunnelId === "string" ? input.tunnelId.trim() : "",
      runtimeKey: typeof input?.runtimeKey === "string" ? input.runtimeKey : "",
      replace: input?.replace === true,
      interactionMode,
    }, afterRuntimeReady);
    if (!interactionModeChange && interactionMode === "automatic") await browserHost.reveal();
    const result = interactionModeChange
      ? await browserHost.withInteractionModeChange(interactionMode, runSetup)
      : await runSetup();
    const state = stateStore.update({
      browserInteractionMode: interactionMode,
      ...(interactionMode === "manual" ? { experimentalBiggerContext: false, experimentalSkillAttachments: false } : {}),
      experimentalSkillAttachments: runtimeHost.runtimeConfigSnapshot().config?.experimentalSkillAttachments === true,
      zeroRiskProEnabled: runtimeHost.runtimeConfigSnapshot().config?.zeroRiskProEnabled === true,
      coreSetupComplete: true,
      codexCatalogVerified: IS_DEV_PROFILE,
      mcpRuntimeInstalled: true,
      mcpSetupComplete: false,
      mcpGuideStep: 2,
      codexRestartRequired: IS_DEV_PROFILE ? false : true,
    });
    send("launcher:state-changed", state);
    if (interactionModeChange) send("launcher:browser-state", browserHost.snapshot());
    if (!IS_DEV_PROFILE) startCatalogVerificationMonitor({ logger, stateStore });
    return { ok: true, stdout: result.stdout };
  });
  handle("launcher:set-mcp-step", (_event, step) => {
    if (!Number.isInteger(step) || step < 0 || step > 2) throw new Error("Invalid MCP guide step");
    return stateStore.update({ mcpGuideStep: step });
  });

  handle("launcher:autostart", (_event, enabled) => {
    if (IS_DEV_PROFILE) throw new Error("The isolated DEV launcher is started explicitly from the repository CLI");
    const desired = enabled === true;
    const autostart = setAutostart(app, desired);
    return {
      state: stateStore.update({ autoStart: desired }),
      ...autostart,
    };
  });
  handle("launcher:bigger-context", async (_event, enabled) => {
    const result = await runtimeHost.setBiggerContext(enabled === true);
    const state = stateStore.update({
      experimentalBiggerContext: result.enabled,
      codexCatalogVerified: IS_DEV_PROFILE ? true : false,
      codexRestartRequired: IS_DEV_PROFILE ? false : true,
    });
    send("launcher:state-changed", state);
    if (!IS_DEV_PROFILE) startCatalogVerificationMonitor({ logger, stateStore });
    return state;
  });
  handle("launcher:skill-attachments", async (_event, enabled) => {
    const blocked = browserOperationBlockMessage(browserHost, "Skills as files");
    if (blocked) throw new Error(blocked);
    const result = await runtimeHost.setSkillAttachments(enabled === true);
    const state = stateStore.update({
      experimentalSkillAttachments: result.enabled,
      codexCatalogVerified: IS_DEV_PROFILE ? true : false,
      codexRestartRequired: IS_DEV_PROFILE ? false : true,
    });
    send("launcher:state-changed", state);
    if (!IS_DEV_PROFILE) startCatalogVerificationMonitor({ logger, stateStore });
    return state;
  });
  handle("launcher:codex-route", async (_event, enabled) => {
    if (IS_DEV_PROFILE) throw new Error("The isolated DEV launcher never routes Codex");
    const desired = enabled === true;
    const route = await runtimeHost.setCodexRoute(desired);
    const state = stateStore.update({
      codexRouteEnabled: desired,
      codexCatalogVerified: !desired,
      ...(route.changed === true ? { codexRestartRequired: true } : {}),
    });
    send("launcher:state-changed", state);
    if (desired) startCatalogVerificationMonitor({ logger, stateStore });
    return state;
  });
  handle("launcher:zero-risk-pro", async (_event, enabled) => {
    const blocked = browserOperationBlockMessage(browserHost, "Zero Risk model profiles");
    if (blocked) throw new Error(blocked);
    const result = await runtimeHost.setZeroRiskPro(enabled === true);
    const state = stateStore.update({
      zeroRiskProEnabled: result.enabled,
      codexCatalogVerified: IS_DEV_PROFILE,
      codexRestartRequired: !IS_DEV_PROFILE,
    });
    send("launcher:state-changed", state);
    if (!IS_DEV_PROFILE) startCatalogVerificationMonitor({ logger, stateStore });
    return state;
  });
  handle("launcher:browser-interaction-mode", async (_event, rawMode) => {
    const mode = validateBrowserInteractionMode(rawMode);
    const current = stateStore.read();
    if (current.browserInteractionMode === mode) {
      return { state: current, credentialsRequired: false, targetMode: mode };
    }
    const blocked = browserOperationBlockMessage(browserHost, "browser interaction mode");
    if (blocked) throw new Error(blocked);
    if (!runtimeHost.mcpCredentialsConfigured(mode)) {
      return { state: current, credentialsRequired: true, targetMode: mode };
    }
    const result = await browserHost.withInteractionModeChange(
      mode,
      afterRuntimeReady => runtimeHost.setBrowserInteractionMode(mode, afterRuntimeReady),
    );
    const state = stateStore.update({
      browserInteractionMode: mode,
      ...(mode === "manual" ? { experimentalBiggerContext: false, experimentalSkillAttachments: false } : {}),
      ...(result.configured ? {
        codexCatalogVerified: IS_DEV_PROFILE,
        codexRestartRequired: !IS_DEV_PROFILE,
      } : {}),
    });
    send("launcher:state-changed", state);
    send("launcher:browser-state", browserHost.snapshot());
    if (!IS_DEV_PROFILE && result.configured) startCatalogVerificationMonitor({ logger, stateStore });
    return { state, credentialsRequired: false, targetMode: mode };
  });
  handle("launcher:set-preference", (_event, key, value) => {
    const ordinary = key === "keepRunningOnClose" || key === "showBrowserDuringTurns";
    if (!ordinary) throw new Error("Unknown preference");
    return stateStore.update({ [key]: value === true });
  });
  handle("launcher:sidebar-state", (_event, value) => stateStore.update(validateSidebarState(value)));
  handle("launcher:logs", (_event, limit) => logger.recent(limit));
  handle("launcher:export-logs", async () => {
    const date = new Date().toISOString().slice(0, 10);
    const copy = nativeCopyFor(stateStore.read().language);
    const result = await dialog.showSaveDialog(mainWindow, {
      title: copy.exportDiagnostics,
      defaultPath: path.join(app.getPath("documents"), `codex-web-gpt-diagnostics-${date}.jsonl`),
      filters: [{ name: "JSON Lines", extensions: ["jsonl"] }],
    });
    if (result.canceled || !result.filePath) return null;
    const recordCount = exportSanitizedLogs({
      filePath: logger.filePath,
      destinationPath: result.filePath,
    });
    logger.info("launcher.logs_exported", { recordCount });
    return result.filePath;
  });
  handle("launcher:update-install", async () => {
    if (!updateController) throw new Error("Launcher updates are unavailable");
    const copy = nativeCopyFor(stateStore.read().language);
    // 29.09: this button installed 5.0.55 while ChatGPT was signed out; the runtime upgrade could not
    // inspect the session and left setup needing a repair. Check the real session first (the flag
    // alone went stale on 29.09 00:08); a check that a running turn blocks is not a refusal.
    if (stateStore.read().browserInteractionMode === "automatic" && browserHost) {
      const browser = await browserHost.refreshAuthentication().catch(() => browserHost.snapshot());
      if (!browser?.authenticated) throw new Error(copy.updateSignInRequired);
    }
    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      buttons: [copy.cancel, copy.updateNow],
      defaultId: 0,
      cancelId: 0,
      title: copy.updateTitle,
      message: copy.updateMessage,
      detail: copy.updateDetail,
    });
    if (confirmation.response !== 1) return false;
    const launch = await updateController.beginInstall({ beforeLaunch: waitForQuietCodexBeforeUpdate });
    const result = await requestQuit({ forUpdate: true });
    if (!result.ok) {
      updateController.cancelInstall(launch);
      throw new Error(result.message);
    }
    return true;
  });
  handle("launcher:update-check", async () => {
    if (!updateController) throw new Error("Launcher updates are unavailable");
    return updateController.checkOnce({ force: true });
  });
  handle("launcher:window-state", (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    return windowStateSnapshot(window);
  });
  ipcMain.on("launcher:window-control", (event, action) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) return;
    if (action === "close") window.close();
    else if (action === "minimize") window.minimize();
    else if (action === "zoom") window.isMaximized() ? window.unmaximize() : window.maximize();
  });
}

async function waitForQuietCodexBeforeUpdate({ signal }) {
  const result = await waitForQuietRuntime({
    signal,
    readActivity: async () => {
      const config = runtimeSupervisor?.readConfig();
      const health = config ? await runtimeSupervisor.proxyHealthPayload(config) : null;
      const protectedActive = pcService?.activeCodexTaskCount() ?? 0;
      if (!Number.isInteger(health?.active_http_turns) || !Number.isInteger(health?.active_browser_turns)) {
        return protectedActive > 0 ? { active: protectedActive, protectedActive, lastEndedAt: null } : null;
      }
      return {
        active: health.active_http_turns + health.active_browser_turns + protectedActive,
        protectedActive,
        lastEndedAt: browserHost?.lastTurnEndedAt ?? null,
      };
    },
  });
  launcherLogger?.info("launcher.update_waited_for_codex", result);
}

async function requestQuit({ forUpdate = false } = {}) {
  if (shutdownInProgress || exitCommitted) {
    return { ok: false, message: "Launcher shutdown is already in progress" };
  }
  shutdownInProgress = true;
  try {
    const activeOperation = runtimeHost?.currentOperation() || browserHost?.currentOperation();
    if (activeOperation) {
      throw new Error(`Wait for ${activeOperation} to finish before quitting Feno Bridge`);
    }
    pcService?.assertCanExit();
    if (forUpdate && (pcService?.activeCodexTaskCount() ?? 0) > 0) {
      throw new Error('A chat Codex task started during update preparation; retry the update after it finishes');
    }
    runtimeStartupAbort.abort();
    pcStartupRetry?.stop();
    pcService?.suspend();
    await runtimeSupervisor?.shutdown({ cancelActiveTurns: true, force: true });
    stopCatalogVerificationMonitor();
    quitting = true;
    await browserHost?.persistSession();
    browserHost?.destroy();
    await browserControl?.close();
    exitCommitted = true;
    disposeTunnelWake?.();
    app.quit();
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    quitting = false;
    showMainWindow();
    publishOperation({ name: "launcher-quit", status: "failed", message });
    return { ok: false, message };
  } finally {
    shutdownInProgress = false;
  }
}

async function start() {
  const lockingDone=bootReporter.begin('single_instance_lock');
  bootLogger.info('launcher.single_instance_lock_call', {});
  const gotLock = app.requestSingleInstanceLock();
  bootLogger.info('launcher.single_instance_lock_return', {gotLock});
  lockingDone();
  if (!gotLock) {
    app.quit();
    return;
  }
  app.on("second-instance", () => handleSecondInstance());
  app.on("activate", () => showMainWindow());

  const portDone=bootReporter.begin('debug_port');
  cdpPort = findFreePort();
  if (process.platform === "linux") {
    app.commandLine.appendSwitch("class", IS_DEV_PROFILE ? "codex-web-gpt-dev" : "codex-web-gpt");
  }
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
  app.commandLine.appendSwitch("remote-debugging-port", String(cdpPort));
  portDone();
  if (app.isReady()) throw new Error("Electron became ready before launcher CDP configuration");

  const readyDone=bootReporter.begin('electron_ready');await app.whenReady();readyDone();
  const receipt=app.isPackaged&&process.platform==='win32'&&!IS_DEV_PROFILE
    ?createRuntimeReceipt({filePath:path.join(launcherUserData,'runtime-install.receipt'),protection:safeStorage}):null;
  const sourceDone=bootReporter.begin('runtime_source');
  const previousReceipt=await receipt?.read();
  let sourceBundle;
  try{
    sourceBundle=await waitForPackagedRuntimeSource({ app, resourcesPath: process.resourcesPath, returnBundle:true,
      inspect:receipt?inspectRuntimeMetadata:inspectRuntimeSource,
      onWait:waitMs=>bootReporter.wait('runtime_source','source_materializing',waitMs) });
  }finally{sourceDone();}
  let installedRuntimeRoot = null;
  let runtimeIntegrityFailed = false;
  const runtimeDone=bootReporter.begin('runtime_install');
  const installation=await ensurePackagedRuntimeAsync({app,coreHome:CORE_HOME,resourcesPath:process.resourcesPath,sourceBundle,receipt,previousReceipt,begin:phase=>bootReporter.begin(phase)});
  runtimeDone();
  const runtimeRootProvider = () => {
    if(runtimeIntegrityFailed||app.isPackaged&&!fs.existsSync(installation.runtimeRoot))throw new Error('Packaged runtime requires verification and restart');
    return installation.runtimeRoot;
  };
  installedRuntimeRoot = runtimeRootProvider();

  const stateDone=bootReporter.begin('state_and_autostart');
  const stateStore = createStateStore(path.join(app.getPath("userData"), "launcher-state.json"));
  if (IS_DEV_PROFILE && !stateStore.read().onboardingComplete) {
    stateStore.update({
      language: stateStore.read().language || "en",
      onboardingComplete: true,
      autoStart: false,
    });
  }
  if (stateStore.read().sessionRefreshReminderAt === null) {
    stateStore.update({ sessionRefreshReminderAt: nextSessionRefreshReminderAt() });
  }
  const persistedState = stateStore.read();
  if (persistedState.coreSetupComplete === true && persistedState.codexCatalogVerified === undefined) {
    stateStore.update({
      coreSetupComplete: false,
      codexCatalogVerified: false,
      codexRestartRequired: false,
    });
  }
  const autostart = IS_DEV_PROFILE ? { supported: false, enabled: false } : getAutostart(app);
  if (!IS_DEV_PROFILE
    && stateStore.read().onboardingComplete
    && autostart.supported
    && stateStore.read().autoStart !== autostart.enabled) {
    setAutostart(app, stateStore.read().autoStart);
  }
  stateDone();
  const logger = createLogger({
    filePath: path.join(app.getPath("logs"), "launcher.jsonl"),
    publish: (record) => send("launcher:log", record),
  });
  launcherLogger = logger;
  if (app.isPackaged && !IS_DEV_PROFILE) {
    try {
      const result = syncBundledGuidance({
        sourcePath: path.join(process.resourcesPath, "guidance", "SKILL.md"),
        codexHome: LAUNCHER_PROFILE.codexHome,
      });
      logger.info("launcher.guidance_sync", { status: result.status });
      if (process.platform === "win32") {
        const routing = syncGlobalRouting({ codexHome: LAUNCHER_PROFILE.codexHome });
        logger.info("launcher.global_routing_sync", { status: routing.status });
        const tools = syncCliTools({
          sourceDir: path.join(process.resourcesPath, "runtime", "tools"),
          coreHome: LAUNCHER_PROFILE.coreHome,
        });
        logger.info("launcher.cli_tools_sync", { status: tools.status });
        if (tools.dir) {
          const cliRouting = syncCliToolsRouting({ codexHome: LAUNCHER_PROFILE.codexHome, toolsDir: tools.dir });
          logger.info("launcher.cli_tools_routing_sync", { status: cliRouting.status });
        }
      }
      const roundTrips = syncRoundTripsRouting({ codexHome: LAUNCHER_PROFILE.codexHome });
      logger.info("launcher.round_trips_routing_sync", { status: roundTrips.status });
    } catch (error) {
      logger.warn("launcher.guidance_sync_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (app.isPackaged && installedRuntimeRoot) {
    // In the background: removing dozens of old bundles takes minutes on Windows.
    pruneRuntimeVersions({
      versionsRoot: path.join(CORE_HOME, "versions"),
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
    }).then(
      result => logger.info("launcher.runtime_versions_pruned", result),
      error => logger.warn("launcher.runtime_versions_prune_failed", {
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
  const startHidden = process.argv.includes("--launcher-smoke-test")
    || (process.argv.includes("--hidden") && stateStore.read().onboardingComplete);
  nativeTheme.themeSource = "system";
  mainWindow = createWindow({
    logger,
    stateStore,
    windowStatePath: path.join(app.getPath("userData"), "window-state.json"),
    startHidden,
  });
  browserControl = await new BrowserControlServer({
    logger,
    getBrowserHost: () => browserHost,
    getPreferences: () => stateStore.read(),
    resolveProxy: url => session.fromPartition(LAUNCHER_PROFILE.browserPartition).resolveProxy(url),
  }).start();
  runtimeSupervisor = new RuntimeSupervisor({
    activeCodexTaskCount: () => pcService?.activeCodexTaskCount() ?? 0,
    app,
    logger,
    sourceRoot: SOURCE_ROOT,
    installedRuntimeRoot,
    runtimeRootProvider,
    coreHome: CORE_HOME,
    browserDescriptorPath: BROWSER_DESCRIPTOR_PATH,
    launcherProfile: LAUNCHER_PROFILE.kind,
    publishOperation,
  });
  runtimeHost = new RuntimeHost({
    app,
    logger,
    sourceRoot: SOURCE_ROOT,
    installedRuntimeRoot,
    runtimeRootProvider,
    browserDescriptorPath: BROWSER_DESCRIPTOR_PATH,
    coreHome: CORE_HOME,
    codexHome: LAUNCHER_PROFILE.codexHome,
    launcherProfile: LAUNCHER_PROFILE.kind,
    publishOperation,
    supervisor: runtimeSupervisor,
    getBrowserInteractionMode: () => stateStore.read().browserInteractionMode,
    getCodexRouteEnabled: () => stateStore.read().codexRouteEnabled !== false,
  });
  const configuredInteractionMode = runtimeHost.runtimeConfigSnapshot().config?.browserInteractionMode;
  if ((configuredInteractionMode === "automatic" || configuredInteractionMode === "manual")
    && stateStore.read().browserInteractionMode !== configuredInteractionMode) {
    stateStore.update({ browserInteractionMode: configuredInteractionMode });
  }
  const launcherSmokeTest = process.argv.includes("--launcher-smoke-test");
  if(!launcherSmokeTest&&!IS_DEV_PROFILE){
    const {bindTunnelWake}=require('./tunnel-wake.cjs');
    const powerEvent=()=>pcService?.powerEvent();
    powerMonitor.on('resume',powerEvent);powerMonitor.on('unlock-screen',powerEvent);
    const dispose=bindTunnelWake(powerMonitor,event=>runtimeSupervisor.checkTunnelAfterPowerEvent(event));
    disposeTunnelWake=()=>{dispose();powerMonitor.removeListener('resume',powerEvent);powerMonitor.removeListener('unlock-screen',powerEvent);};
  }
  browserHost = new BrowserHost({
    window: mainWindow,
    descriptorPath: BROWSER_DESCRIPTOR_PATH,
    cdpPort,
    control: browserControl.descriptor(),
    cancelTurn: IS_DEV_PROFILE ? undefined : (traceId, reason) => runtimeSupervisor.cancelBrowserTurn(traceId, reason),
    getConnectorName: () => runtimeHost.browserConnectorName(),
    helper: { executable: process.execPath, script: BROWSER_HELPER_PATH },
    logger,
    loginWithPasskey: () => runtimeHost.capturePasskeyLogin(),
    partition: LAUNCHER_PROFILE.browserPartition,
    profile: LAUNCHER_PROFILE.kind,
    publishState: (state) => send("launcher:browser-state", state),
    showWindow: showMainWindow,
    getBrowserInteractionMode: () => stateStore.read().browserInteractionMode,
    initializationAttempts: browserInitializationAttempts(process.platform,launcherSmokeTest),
  });
  if (!launcherSmokeTest) await browserHost.ready();
  const updaterRuntimeRoot = runtimeRootProvider();
  updateController = createUpdateController({
    currentVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged && !IS_DEV_PROFILE,
    executablePath: process.execPath,
    runtimeExecutable: updaterRuntimeRoot
      ? runtimeBundlePaths(updaterRuntimeRoot, process.platform).executable
      : null,
    logsDirectory: app.getPath("logs"),
    publish: (state) => send("launcher:update-state", state),
    logger,
  });
  if (process.platform === "win32" && !launcherSmokeTest) {
    const { createPcStartupRetry } = require('./pc-startup-retry.cjs');
    pcStartupRetry = createPcStartupRetry({ start() {
    try {
      const root = runtimeRootProvider();
      const bunPath = app.isPackaged && root
        ? runtimeBundlePaths(root).executable
        : process.env.CODEX_CHATGPT_WEB_BUN || process.env.CODEX_WEB_GPT_BUN;
      if (!bunPath || !path.isAbsolute(bunPath)) throw new Error("pc_trusted_runtime_required");
      pcService = createPcLauncherService({
        profile: { ...LAUNCHER_PROFILE, userData: launcherUserData }, bunPath,
        confirmCodexTaskLocally: async (request, signal) => {
          const response = await dialog.showMessageBox({
            type: 'warning', title: 'Feno Bridge — Sohbetten Codex görevi',
            message: request.title,
            detail: `Klasör: ${request.projectRoot}\nAlt ajan sınırı: ${request.maxSubagents}\nSüre sınırı: ${request.timeoutMinutes} dakika\n\nGörev metni:\n${request.promptPreview}`,
            buttons: ['Başlat', 'Reddet'], defaultId: 1, cancelId: 1, noLink: true, signal,
          });
          return !signal.aborted && response.response === 0;
        },
        ...(!IS_DEV_PROFILE&&app.isPackaged?{chromeOptions:{version:app.getVersion(),directory:chromeDirectory(),audit:record=>logger.info("pc_control.chrome",record)}}:{}),
        confirmLocally: async selection => {
          if (!mainWindow || mainWindow.isDestroyed()) return false;
          const response = await dialog.showMessageBox(mainWindow, {
            type: "warning", title: "Feno Bridge — Yerel PC onayı",
            message: selection.durationMs === null ? "Bu profil için açıkça iptal edilene kadar PC erişimine izin verilsin mi?" : "Bu profil için bir saatlik PC erişimine izin verilsin mi?",
            detail: `Profil: ${LAUNCHER_PROFILE.kind}\nProje: ${selection.roots.join(", ")}\nİzinler: ${selection.permissions.join(", ")}\n\nTerminal ve proje betikleri Windows hesabınızın yetkileriyle çalışır. Proje klasörü bir sandbox değildir; kişisel dosyalara ve ağa erişebilir, proje dışında değişiklik yapabilir. Mevcut DEV izni bu onaydan bağımsızdır.`,
            buttons: ["İzin ver", "Vazgeç"], defaultId: 1, cancelId: 1, noLink: true,
          });
          return response.response === 0;
        },
        confirmRetirementLocally: async retired => {
          if (!mainWindow || mainWindow.isDestroyed()) return false;
          const response = await dialog.showMessageBox(mainWindow, {
            type: "warning", title: "Feno Bridge — DEV kaynak koordinasyonu",
            message: retired ? "DEV emekliye ayrılsın mı?" : "DEV emeklilik işareti kaldırılsın mı?",
            detail: retired
              ? "Yalnızca bu bilgisayardaki eski ve çalışmayan DEV kurulumu için geçerlidir. DEV yeniden başlatılırsa terminal ve işler güvenlik için durdurulur."
              : "Bu işlem normal profilin tek başına iş ve terminal çalıştırmasını yeniden kısıtlayabilir.",
            buttons: [retired ? "Emekliye ayır" : "Geri al", "Vazgeç"], defaultId: 1, cancelId: 1, noLink: true,
          });
          return response.response === 0;
        },
        audit: ({ action, reason, code, consecutiveFailures,op,nativeCode }) => {
          if(action==='auto_suspended')logger.warn('pc_control.auto_suspended',{reason,code,consecutiveFailures,op,nativeCode});
          else if(action==='expired')logger.info('pc_control.grant_expired',{reason:'expired'});
          else if(action==='invalid_clock')logger.warn('pc_control.auto_suspended',{reason:'invalid_clock',code:'pc_access_denied',consecutiveFailures:0});
          else if(action==='heartbeat_transient_error')logger.warn('pc_control.heartbeat_transient_error',{reason,code,consecutiveFailures,op,nativeCode});
          else if(action==='full_access_enabled')logger.info('pc_control.full_access_enabled',{});
          else if(action==='full_access_disabled')logger.info('pc_control.full_access_disabled',{});
          else if(action==='full_access_recovery_failed')logger.warn('pc_control.full_access_recovery_failed',{code,op,nativeCode});
          else if(action==='full_access_config_retry')logger.warn('pc_control.full_access_config_retry',{code});
          else logger.info('pc_control.local_consent',{action});
        },
      });
      pcService.start();
    } catch (error) {
      try { pcService?.suspend(); } catch {}
      pcService = null;
      throw error;
    }
    }, onFailure: error => logger.warn("pc_control.unavailable", error) });
  }
  registerIpc({ logger, stateStore });
  const trayAvailable = !launcherSmokeTest && createTray(logger, stateStore.read().language);
  if (!launcherSmokeTest && startHidden && !trayAvailable) mainWindow.once("ready-to-show", () => showMainWindow());
  let startupAuthenticationRefresh = Promise.resolve();
  if (!launcherSmokeTest && stateStore.read().browserInteractionMode === "automatic") {
    startupAuthenticationRefresh = browserHost.refreshAuthentication().catch((error) => {
      logger.warn("browser.session_refresh_failed", {
        ...navigationErrorForLog(error),
      });
    });
  }
  const rendererDone = launcherSmokeTest ? bootReporter.begin('smoke_renderer') : () => {};
  await loadRenderer(mainWindow);
  rendererDone();
  if (!launcherSmokeTest) void updateController.checkOnce();
  if (launcherSmokeTest) {
    const smokeRuntimeRoot = runtimeRootProvider();
    if (app.isPackaged && !smokeRuntimeRoot) {
      throw new Error("Packaged launcher smoke test could not install its durable runtime");
    }
    const versionDone = bootReporter.begin('smoke_runtime_version');
    const versionInvocation = runtimeSupervisor.runtimeCommand(["--version"]);
    const versionResult = spawnSync(versionInvocation.executable, versionInvocation.args, {
      cwd: versionInvocation.cwd,
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    });
    if (versionResult.error) throw versionResult.error;
    if (versionResult.status !== 0 || versionResult.stdout.trim() !== app.getVersion()) {
      throw new Error(
        `Installed launcher runtime is not executable`
        + ` (status=${versionResult.status ?? "unknown"}, stdout=${JSON.stringify(versionResult.stdout.trim())},`
        + ` stderr=${JSON.stringify(versionResult.stderr.trim())})`,
      );
    }
    versionDone();
    const browserDone = bootReporter.begin('smoke_browser');
    // Exercise the real browser CDP server and the actual packaged daemon, with an
    // isolated browser-only configuration. No account, tunnel or full-access grant.
    await browserHost.ready();
    const cdpResponse = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, {
      signal: AbortSignal.timeout(10000),
    });
    const cdpVersion = await cdpResponse.json();
    if (cdpResponse.status !== 200 || !cdpVersion.webSocketDebuggerUrl) {
      throw new Error(`Packaged launcher CDP endpoint returned ${cdpResponse.status}`);
    }
    browserDone();
    const configPath = path.join(CORE_HOME, "config.json");
    const runtime = runtimeSupervisor.runtimeCommand([]);
    const config = {
      version: 3, releaseVersion: app.getVersion(), mode: "browser-only",
      browserInteractionMode: "automatic", appName: "Feno Package Smoke",
      host: "127.0.0.1", port: findFreePort(), contextWindow: 256000,
      browserHost: "launcher", browserHostDescriptorPath: BROWSER_DESCRIPTOR_PATH,
      chromeExecutablePath: process.execPath, storageStatePath: path.join(CORE_HOME, "storage-state.json"),
      brokerSocketPath: process.platform === "win32"
        ? `\\\\.\\pipe\\feno-package-smoke-${process.pid}` : path.join(CORE_HOME, "broker.sock"),
      headed: true, solAvailable: true, proAvailable: true, autoApproveToolCalls: false,
      controlToken: require("node:crypto").randomBytes(32).toString("hex"),
      runtimeCommand: [runtime.executable, ...runtime.args],
      acknowledgedUnofficialAt: new Date().toISOString(), pcFullAccess: false,
    };
    // Smoke is isolated and deliberately reuses the same durable runtime on its second launch.
    fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    fs.writeFileSync(config.storageStatePath, "{}", { mode: 0o600 });
    let pcServiceStarted = false;
    try {
      const daemonDone = bootReporter.begin('smoke_daemon_start');
      const startup = await runtimeSupervisor.startIfConfigured();
      daemonDone();
      if (startup.status !== "ready" || !startup.daemonPid) {
        throw new Error(`Packaged runtime startup failed: ${JSON.stringify(startup)}`);
      }
      if (process.platform === "win32") {
        pcService = createPcLauncherService({
          profile: { ...LAUNCHER_PROFILE, userData: launcherUserData },
          bunPath: runtime.executable,
          confirmLocally: async () => false,
          confirmRetirementLocally: async () => false,
          testPeerEvidence: {
            inspectDevLaunchers: () => ({ state: "absent", pids: [] }),
            devHome: process.env.CODEX_WEB_GPT_DEV_HOME,
            devInstallPaths: [path.join(path.dirname(process.env.CODEX_WEB_GPT_DEV_HOME), "dev-install")],
          },
        });
        pcService.start();
        pcServiceStarted = pcService.status().available === true;
        if (!pcServiceStarted) throw new Error("Packaged PC service did not start");
        logger.info("pc_control.smoke_service_started", {});
      }
      await installation.verifyInBackground?.();
    } finally {
      const shutdownDone = bootReporter.begin('smoke_daemon_stop');
      try { pcService?.suspend(); }
      finally { await runtimeSupervisor.shutdown({ cancelActiveTurns: true, force: true }); }
      shutdownDone();
    }
    const markerPath = process.env.CODEX_WEB_GPT_SMOKE_FILE?.trim();
    if (!markerPath || !path.isAbsolute(markerPath)) {
      throw new Error("Packaged launcher smoke test requires an absolute CODEX_WEB_GPT_SMOKE_FILE");
    }
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, `${JSON.stringify({
      ok: true,
      version: app.getVersion(),
      platform: process.platform,
      packaged: app.isPackaged,
      runtimeVerified: true,
      cdpStatus: cdpResponse.status,
      runtimeStartupVerified: true,
      pcServiceStarted,
    })}\n`);
    const cleanupDone = bootReporter.begin('smoke_browser_cleanup');
    browserHost.destroy();
    await browserControl.close();
    mainWindow.destroy();
    cleanupDone();
    app.quit();
    return;
  }
  if (IS_DEV_PROFILE) {
    let config = null;
    try {
      config = runtimeSupervisor.readConfig();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("dev_profile.config_invalid", { message });
      publishOperation({ name: "dev-profile", status: "failed", message });
    }
    const state = stateStore.update({
      coreSetupComplete: Boolean(config),
      codexCatalogVerified: Boolean(config),
      mcpRuntimeInstalled: config?.mode === "full",
      ...(config?.mode !== "full" ? { mcpSetupComplete: false, mcpGuideStep: 0 } : {}),
      codexRestartRequired: false,
      autoStart: false,
      experimentalBiggerContext: config?.experimentalBiggerContext === true,
      experimentalSkillAttachments: config?.experimentalSkillAttachments === true,
      zeroRiskProEnabled: config?.zeroRiskProEnabled === true,
    });
    send("launcher:state-changed", state);
    logger.info("dev_profile.ready", {
      configured: Boolean(config),
      mode: config?.mode || null,
      coreHome: CORE_HOME,
      userData: launcherUserData,
    });
    pcStartupRetry?.start();
    if (config?.mode === "full") {
      void startupAuthenticationRefresh.then(() => runtimeSupervisor.startIfConfigured()).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("dev_profile.runtime_start_failed", { message });
        const failed = stateStore.update({ mcpSetupComplete: false });
        send("launcher:state-changed", failed);
      }).finally(finishRuntimeStartup);
    } else finishRuntimeStartup();
  } else void retryRuntimeStartup(async () => {
    await startupAuthenticationRefresh;
    const upgrade = await runtimeHost.upgradeManagedRuntime();
    pcStartupRetry?.start();
    if (upgrade.updated) {
      const state = stateStore.update({
        coreSetupComplete: true,
        codexCatalogVerified: false,
        codexRestartRequired: true,
        experimentalBiggerContext: runtimeHost.runtimeConfigSnapshot().config?.experimentalBiggerContext === true,
        experimentalSkillAttachments: runtimeHost.runtimeConfigSnapshot().config?.experimentalSkillAttachments === true,
        zeroRiskProEnabled: runtimeHost.runtimeConfigSnapshot().config?.zeroRiskProEnabled === true,
        ...(upgrade.mode === "full" ? {
          mcpRuntimeInstalled: true,
          mcpSetupComplete: false,
          mcpGuideStep: 2,
        } : {
          mcpRuntimeInstalled: false,
          mcpSetupComplete: false,
          mcpGuideStep: 0,
        }),
      });
      send("launcher:state-changed", state);
      logger.info("runtime.release_upgraded", {
        fromVersion: upgrade.fromVersion,
        toVersion: upgrade.toVersion,
        mode: upgrade.mode,
        connectorMigrated: upgrade.connectorMigrated,
      });
    }
    const configuredRuntime = runtimeHost.runtimeConfigSnapshot();
    if (configuredRuntime.configured) {
      const enabled = configuredRuntime.config?.experimentalBiggerContext === true;
      const experimentalSkillAttachments = configuredRuntime.config?.experimentalSkillAttachments === true;
      const zeroRiskProEnabled = configuredRuntime.config?.zeroRiskProEnabled === true;
      const saved = stateStore.read();
      if (saved.experimentalSkillAttachments !== experimentalSkillAttachments
        || saved.experimentalBiggerContext !== enabled
        || saved.zeroRiskProEnabled !== zeroRiskProEnabled) {
        const state = stateStore.update({ experimentalBiggerContext: enabled, experimentalSkillAttachments, zeroRiskProEnabled });
        send("launcher:state-changed", state);
      }
    }
    const runtime = await runtimeSupervisor.startIfConfigured();
    if (runtime.status !== "ready") return runtime;
    if (stateStore.read().codexRouteEnabled === false) {
      const route = await runtimeHost.restoreBridgeRoute("bridge-route-opt-out");
      return { ...runtime, bridgeRouteChanged: route.changed === true, codexRouteEnabled: false };
    }
    const route = await runtimeHost.connectBridgeRoute();
    return { ...runtime, bridgeRouteChanged: route.changed === true };
  }, {
    signal: runtimeStartupAbort.signal,
    onRetry: detail => logger.warn("runtime.startup_retry", detail),
  }).then(async (runtime) => {
    if (runtime.status === "ready") {
      const config = runtimeSupervisor.readConfig();
      const current = stateStore.read();
      const patch = {
        coreSetupComplete: true,
        mcpRuntimeInstalled: config.mode === "full",
        experimentalBiggerContext: config.experimentalBiggerContext === true,
        experimentalSkillAttachments: config.experimentalSkillAttachments === true,
        zeroRiskProEnabled: config.zeroRiskProEnabled === true,
        ...(runtime.codexRouteEnabled === false ? {
          codexCatalogVerified: true,
          ...(runtime.bridgeRouteChanged ? { codexRestartRequired: true } : {}),
        } : runtime.bridgeRouteChanged ? {
          codexCatalogVerified: false,
          codexRestartRequired: true,
        } : {}),
        ...(config.mode === "browser-only" ? {
          mcpSetupComplete: false,
          mcpGuideStep: 0,
        } : {}),
      };
      if (Object.entries(patch).some(([key, value]) => current[key] !== value)) {
        const state = stateStore.update(patch);
        send("launcher:state-changed", state);
      }
      startCatalogVerificationMonitor({ logger, stateStore });
      const automatic = stateStore.read().browserInteractionMode === "automatic";
      const authenticated = browserHost?.snapshot?.().authenticated === true;
      recordStartupReadiness(
        automatic && !authenticated ? "sign-in-required" : "ready",
        automatic && !authenticated ? "ChatGPT sign-in is required" : "",
      );
      return;
    }
    if (runtime.status === "not-configured") {
      const routeRecovery = await restoreCodexRouteAfterRuntimeFailure({ logger, stateStore });
      const current = stateStore.read();
      if (current.coreSetupComplete || current.mcpRuntimeInstalled || current.mcpSetupComplete) {
        const state = stateStore.update({
          coreSetupComplete: false,
          codexCatalogVerified: false,
          mcpRuntimeInstalled: false,
          mcpSetupComplete: false,
          mcpGuideStep: 0,
        });
        send("launcher:state-changed", state);
      }
      if (routeRecovery.error) {
        publishOperation({
          name: "runtime-start",
          status: "failed",
          message: `Local runtime is not configured; restoring the previous Codex route also failed: ${routeRecovery.error}`,
        });
      }
      recordStartupReadiness(
        routeRecovery.error ? "repair-required" : "setup-required",
        routeRecovery.error
          ? `Local runtime is not configured and the previous Codex route could not be restored: ${routeRecovery.error}`
          : "Local runtime is not configured yet",
      );
      return;
    }
    const routeRecovery = await restoreCodexRouteAfterRuntimeFailure({ logger, stateStore });
    const state = stateStore.update({ coreSetupComplete: false, codexCatalogVerified: false });
    send("launcher:state-changed", state);
    if (runtime.status === "external" || runtime.status === "needs-setup") {
      const detail = runtime.detail || (
        runtime.status === "external"
          ? "Another process owns the configured Feno Bridge runtime"
          : "The installed runtime configuration must be repaired from Setup"
      );
      publishOperation({
        name: "runtime-start",
        status: "failed",
        message: routeRecovery.error
          ? `${detail}; restoring the previous Codex route also failed: ${routeRecovery.error}`
          : routeRecovery.restored
            ? `${detail}; the previous Codex route was restored, restart Codex once`
            : detail,
      });
      recordStartupReadiness("repair-required", detail);
      return;
    }
    recordStartupReadiness("repair-required", `Unexpected runtime startup status: ${runtime.status || "unknown"}`);
  }).catch(async (error) => {
    if (runtimeStartupAbort.signal.aborted) return;
    const primary = error instanceof Error ? error.message : String(error);
    const routeRecovery = await restoreCodexRouteAfterRuntimeFailure({ logger, stateStore });
    const message = routeRecovery.error
      ? `${primary}; restoring the previous Codex route also failed: ${routeRecovery.error}`
      : routeRecovery.restored
        ? `${primary}; the previous Codex route was restored, restart Codex once`
        : primary;
    logger.error("runtime.startup_failed", { message });
    const state = stateStore.update({ coreSetupComplete: false, codexCatalogVerified: false });
    send("launcher:state-changed", state);
    publishOperation({ name: "runtime-start", status: "failed", message });
    recordStartupReadiness("repair-required", message);
  }).finally(finishRuntimeStartup);

  if(installation.verifyInBackground){
    // Wait for the normal runtime/tunnel startup and briefly for asynchronously restored
    // full access. Even unconfigured launchers verify within a bounded interval.
    const verify=async()=>{
      try{
        await installation.verifyInBackground();
        logger.info('launcher.runtime_background_verified',{});
      }catch(error){
        runtimeIntegrityFailed=true;
        logger.error('launcher.runtime_background_rejected',{code:'runtime_integrity_mismatch'});
        runtimeStartupAbort.abort();pcStartupRetry?.stop();
        try{pcService?.suspend();}catch{}
        try{await runtimeSupervisor?.shutdown({cancelActiveTurns:true,force:true});}finally{app.exit(1);}
      }
    };
    void (async()=>{
      let timeout;
      try{
        await Promise.race([runtimeStartup,new Promise(resolve=>{timeout=setTimeout(resolve,30000);})]);
        if(runtimeHost.runtimeConfigSnapshot().config?.pcFullAccess===true){
          const deadline=Date.now()+30000;
          while(!pcService?.status()?.fullAccess&&Date.now()<deadline&&!quitting)await new Promise(resolve=>setTimeout(resolve,500));
        }
      }catch{/* A failed readiness check must not suppress integrity verification. */}
      finally{clearTimeout(timeout);}
      if(!quitting)await verify();
    })();
  }

  app.on("before-quit", (event) => {
    if (exitCommitted) return;
    event.preventDefault();
    void requestQuit();
  });
  process.once("SIGINT", () => { void requestQuit(); });
  process.once("SIGTERM", () => { void requestQuit(); });
}

void start().catch(async (error) => {
  startupFailed = true;
  startupFailureTransient = error?.code === RUNTIME_SOURCE_NOT_READY;
  pcStartupRetry?.stop();
  try { pcService?.suspend(); } catch {}
  const message = error instanceof Error ? error.message : String(error);
  try {
    fs.appendFileSync(path.join(app.getPath("logs"), "launcher-fatal.log"), `${new Date().toISOString()} ${error?.stack || error}\n`);
  } catch {}
  try {
    // Browser bootstrap can fail before the renderer is loaded. Keep the error reachable
    // through the existing instance, and release browser resources before a user retry.
    const smoke = process.argv.includes("--launcher-smoke-test");
    if (smoke) bootLogger.error('launcher.smoke_failed', {code:error?.code});
    const cleanupErrors = [];
    try { browserHost?.destroy(); } catch (caught) { cleanupErrors.push(String(caught)); }
    try { await browserControl?.close(); } catch (caught) { cleanupErrors.push(String(caught)); }
    if (smoke) { app.exit(1); return; }
    await app.whenReady();
    quitting = true;
    showMainWindow();
    const copy = nativeCopyFor(createStateStore(path.join(app.getPath("userData"), "launcher-state.json")).read().language);
    const options = {
      type: "error",
      title: copy.startupTitle,
      message,
      detail: [copy.startupDetail,
        ...cleanupErrors.map(detail => `${copy.startupCleanupFailed}: ${detail}`)].join("\n"),
      buttons: [copy.retry, copy.quit],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    };
    const result = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options);
    if (result.response === 0) relaunchAfterFailedStart();
  } finally {
    // A failed dialog or relaunch must not leave a headless single-instance owner behind.
    app.exit(1);
  }
});
