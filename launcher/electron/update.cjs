const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const RELEASE_REPOSITORY = "Ahmet1991/feno-bridge";
const RELEASE_API_URL = `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/latest`;
const RELEASE_HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": "Feno-Bridge-Updater",
};

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(value || "").trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || null,
  };
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw new Error(`Invalid release version comparison: ${left} / ${right}`);
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return a.prerelease.localeCompare(b.prerelease, "en", { numeric: true });
}

function releaseVersion(tagName) {
  const version = String(tagName || "").replace(/^v/, "");
  if (!parseVersion(version)) throw new Error(`GitHub returned an invalid release tag: ${tagName}`);
  return version;
}

function releaseAssetName(version, platform = process.platform, arch = process.arch) {
  if (platform === "darwin" && ["arm64", "x64"].includes(arch)) {
    return `feno-bridge-${version}-mac-${arch}.zip`;
  }
  if (platform === "win32" && arch === "x64") {
    return `feno-bridge-${version}-win-x64.exe`;
  }
  if (platform === "linux" && arch === "x64") {
    return `feno-bridge-${version}-linux-x64.AppImage`;
  }
  return null;
}

function expectedChecksum(contents, assetName) {
  for (const line of String(contents || "").split(/\r?\n/)) {
    const match = /^([a-fA-F0-9]{64})\s+(.+)$/.exec(line.trim());
    if (match && match[2] === assetName) return match[1].toLowerCase();
  }
  throw new Error(`checksums.txt has no entry for ${assetName}`);
}

function validateReleaseAssetUrl(raw, version, assetName) {
  const url = new URL(raw);
  const expectedPath = `/${RELEASE_REPOSITORY}/releases/download/v${version}/${assetName}`;
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.pathname !== expectedPath) {
    throw new Error(`GitHub returned an unexpected release asset URL for ${assetName}`);
  }
  return url.toString();
}

function releaseAssetParts(raw) {
  const url = new URL(raw);
  const prefix = `/${RELEASE_REPOSITORY}/releases/download/`;
  if (url.protocol !== "https:" || url.hostname !== "github.com"
    || !url.pathname.startsWith(prefix) || url.search || url.hash) {
    throw new Error("Unexpected private release URL");
  }
  const [tag, asset, extra] = url.pathname.slice(prefix.length).split("/");
  if (!tag || !asset || extra || !parseVersion(tag.replace(/^v/, ""))) {
    throw new Error("Unexpected private release asset");
  }
  return { tag, asset };
}

function retryAfterMilliseconds(response, fallbackMs) {
  const raw = response?.headers?.get?.("retry-after")?.trim();
  if (!raw) return fallbackMs;
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Math.min(30_000, Math.max(0, Math.ceil(Number(raw) * 1000)));
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return fallbackMs;
  return Math.min(30_000, Math.max(0, at - Date.now()));
}

function transientHttpStatus(status) {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

async function checkedFetch(url, fetchImpl = globalThis.fetch, options = {}) {
  if (typeof fetchImpl !== "function") throw new Error("HTTPS update support is unavailable in this runtime");
  const {
    signal,
    headerTimeoutMs = 15_000,
    maxAttempts = 3,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = options;
  if (!Number.isFinite(headerTimeoutMs) || headerTimeoutMs <= 0) throw new Error("Update header timeout must be positive");
  if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) throw new Error("Update request attempts must be positive");

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Update request cancelled");
    const controller = new AbortController();
    const relayAbort = () => controller.abort(signal?.reason || new Error("Update request cancelled"));
    signal?.addEventListener?.("abort", relayAbort, { once: true });
    const timeout = setTimeout(() => {
      controller.abort(new Error(`GitHub release response headers timed out after ${headerTimeoutMs} ms`));
    }, headerTimeoutMs);
    let response;
    let failure = null;
    try {
      response = await fetchImpl(url, { headers: RELEASE_HEADERS, redirect: "follow", signal: controller.signal });
      if (!response?.ok) {
        failure = new Error(`GitHub release request failed with HTTP ${response?.status ?? "unknown"}`);
        failure.httpStatus = response?.status;
      }
    } catch (error) {
      failure = controller.signal.aborted && controller.signal.reason instanceof Error
        ? controller.signal.reason
        : error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener?.("abort", relayAbort);
    }

    if (!failure) return response;
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Update request cancelled");
    const status = failure.httpStatus;
    const transient = status === undefined || transientHttpStatus(status);
    if (!transient || attempt >= maxAttempts) throw failure;
    const fallbackMs = Math.min(2_000, 250 * (2 ** (attempt - 1)));
    await sleep(status === 429 ? retryAfterMilliseconds(response, fallbackMs) : fallbackMs);
  }
  throw new Error("GitHub release request exhausted its retry budget");
}

async function fetchPublicRelease(fetchImpl = globalThis.fetch) {
  const response = await checkedFetch(RELEASE_API_URL, fetchImpl);
  const release = await response.json();
  releaseVersion(release?.tag_name);
  return release;
}

function cancellationError(signal) {
  return signal?.reason instanceof Error ? signal.reason : new Error("Update request cancelled");
}

async function readBodyChunk(reader, signal, timeoutMs) {
  if (signal?.aborted) throw cancellationError(signal);
  let timer = null;
  let abortListener = null;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`GitHub release response body timed out after ${timeoutMs} ms`)), timeoutMs);
      }),
      ...(signal ? [new Promise((_, reject) => {
        abortListener = () => reject(cancellationError(signal));
        signal.addEventListener("abort", abortListener, { once: true });
      })] : []),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abortListener) signal.removeEventListener("abort", abortListener);
  }
}

async function readResponseBody(response, {
  signal,
  bodyStallTimeoutMs = 30_000,
  onChunk,
} = {}) {
  if (!response?.body?.getReader) throw new Error("GitHub release download returned an empty body");
  if (!Number.isFinite(bodyStallTimeoutMs) || bodyStallTimeoutMs <= 0) {
    throw new Error("Update body stall timeout must be positive");
  }
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await readBodyChunk(reader, signal, bodyStallTimeoutMs);
      if (done) break;
      if (value?.byteLength) await onChunk?.(value);
    }
  } catch (error) {
    try { await reader.cancel(error); } catch {}
    throw error;
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

async function downloadPublicText(url, options = {}) {
  const response = await checkedFetch(url, options.fetchImpl || globalThis.fetch, options);
  const chunks = [];
  await readResponseBody(response, {
    signal: options.signal,
    bodyStallTimeoutMs: options.bodyStallTimeoutMs,
    onChunk: (chunk) => chunks.push(Buffer.from(chunk)),
  });
  return Buffer.concat(chunks).toString("utf8");
}

async function downloadPublicFile(url, destination, options = {}) {
  const {
    signal,
    fetchImpl = globalThis.fetch,
    headerTimeoutMs,
    bodyStallTimeoutMs = 30_000,
    maxAttempts = 3,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    onProgress,
  } = options;
  if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) throw new Error("Update download attempts must be positive");
  const partial = `${destination}.part`;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal?.aborted) throw cancellationError(signal);
    fs.rmSync(partial, { force: true });
    let handle = null;
    try {
      const response = await checkedFetch(url, fetchImpl, {
        signal,
        headerTimeoutMs,
        maxAttempts: 1,
      });
      const contentLength = Number(response?.headers?.get?.("content-length"));
      const totalBytes = Number.isFinite(contentLength) && contentLength >= 0 ? contentLength : null;
      let receivedBytes = 0;
      handle = fs.openSync(partial, "w", 0o600);
      await readResponseBody(response, {
        signal,
        bodyStallTimeoutMs,
        onChunk: (chunk) => {
          const buffer = Buffer.from(chunk);
          fs.writeSync(handle, buffer);
          receivedBytes += buffer.byteLength;
          onProgress?.({ receivedBytes, totalBytes });
        },
      });
      fs.closeSync(handle);
      handle = null;
      fs.renameSync(partial, destination);
      return;
    } catch (error) {
      if (handle !== null) {
        try { fs.closeSync(handle); } catch {}
      }
      fs.rmSync(partial, { force: true });
      if (signal?.aborted) throw cancellationError(signal);
      if (attempt >= maxAttempts) throw error;
      await sleep(Math.min(2_000, 250 * (2 ** (attempt - 1))));
    }
  }
}

function sha256(filePath) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function macApplicationPath(executablePath) {
  const match = /^(.*\.app)[\\/]Contents[\\/]MacOS[\\/][^\\/]+$/.exec(executablePath);
  if (!match?.[1]) throw new Error(`Could not resolve the macOS application bundle from ${executablePath}`);
  return match[1];
}

function windowsApplicationPath(executablePath, localAppData = process.env.LOCALAPPDATA) {
  if (!localAppData || !path.win32.isAbsolute(localAppData) || !path.win32.isAbsolute(executablePath)) {
    return executablePath;
  }
  const executable = path.win32.normalize(executablePath);
  const legacyDirectory = path.win32.normalize(path.win32.join(localAppData, "Programs", "Codex Web GPT"));
  if (path.win32.dirname(executable).toLowerCase() !== legacyDirectory.toLowerCase()) return executablePath;
  const name = path.win32.basename(executable).toLowerCase();
  if (name !== "feno bridge.exe" && name !== "codex web gpt.exe") return executablePath;
  return path.win32.join(localAppData, "Programs", "Feno Bridge", "Feno Bridge.exe");
}

function findMacApplication(root) {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const appEntry = entries.find((entry) => entry.isDirectory() && entry.name.endsWith(".app"));
  if (!appEntry) throw new Error("The macOS update archive does not contain an application bundle");
  const application = path.join(root, appEntry.name);
  const executable = path.join(application, "Contents", "MacOS", "Feno Bridge");
  if (!fs.existsSync(executable) || !fs.statSync(executable).isFile()) {
    throw new Error("The macOS update archive is incomplete");
  }
  return application;
}

function buildJob({ version, platform, executablePath, assetPath, stagingRoot, tempRoot, logPath }) {
  if (platform === "darwin") {
    return {
      version,
      platform,
      parentPid: process.pid,
      tempRoot,
      logPath,
      source: findMacApplication(stagingRoot),
      target: macApplicationPath(executablePath),
      readyPath: path.join(path.dirname(logPath), "launcher-ready.json"),
    };
  }
  if (platform === "win32") {
    return {
      version,
      platform,
      parentPid: process.pid,
      tempRoot,
      logPath,
      source: assetPath,
      target: windowsApplicationPath(executablePath),
      fallbackTarget: executablePath,
      readyPath: path.join(path.dirname(logPath), "launcher-ready.json"),
    };
  }
  if (platform === "linux") {
    const target = process.env.CODEX_WEB_GPT_APPIMAGE?.trim()
      || process.env.APPIMAGE?.trim();
    if (!target || !path.isAbsolute(target)) {
      throw new Error("The running Linux AppImage path is unavailable; reinstall with install-launcher.sh");
    }
    const wrapper = process.env.CODEX_WEB_GPT_LAUNCHER_EXECUTABLE?.trim();
    if (!wrapper || !path.isAbsolute(wrapper)) {
      throw new Error("Linux auto-update requires the stable install-launcher.sh wrapper; reinstall once");
    }
    return {
      version,
      platform,
      parentPid: process.pid,
      tempRoot,
      logPath,
      source: assetPath,
      target,
      wrapper,
      runnerSource: path.join(tempRoot, "linux-appimage-runner.sh"),
      readyPath: path.join(path.dirname(logPath), "launcher-ready.json"),
    };
  }
  throw new Error(`Updates are not supported on ${platform}`);
}

function defaultDependencies() {
  return {
    fetchRelease: fetchPublicRelease,
    downloadText: downloadPublicText,
    downloadFile: downloadPublicFile,
    sha256,
    extractMac(archive, destination) {
      fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
      const result = spawnSync("/usr/bin/ditto", ["-x", "-k", archive, destination], {
        encoding: "utf8",
        timeout: 120_000,
      });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`Could not extract the macOS update: ${result.stderr.trim()}`);
    },
    linuxRunnerSource() {
      if (typeof process.resourcesPath === "string" && process.resourcesPath) {
        const unpacked = path.join(
          process.resourcesPath,
          "app.asar.unpacked",
          "assets",
          "linux-appimage-runner.sh",
        );
        if (fs.statSync(unpacked, { throwIfNoEntry: false })?.isFile()) return unpacked;
      }
      const source = path.resolve(__dirname, "..", "assets", "linux-appimage-runner.sh");
      if (fs.statSync(source, { throwIfNoEntry: false })?.isFile()) return source;
      throw new Error("Packaged Linux AppImage runner is missing");
    },
    spawnWorker(runtimeExecutable, workerPath, jobPath) {
      return spawn(runtimeExecutable, [workerPath, jobPath], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
    },
  };
}

function createUpdateController({
  currentVersion,
  platform,
  arch,
  packaged,
  executablePath,
  runtimeExecutable,
  logsDirectory,
  publish,
  logger,
  dependencies = {},
}) {
  const deps = { ...defaultDependencies(), ...dependencies };
  const supportedAsset = releaseAssetName(currentVersion, platform, arch);
  let state = packaged && supportedAsset ? { status: "idle" } : { status: "disabled" };
  let checked = false;
  let checkGeneration = 0;
  let pending = null;
  let pendingAbortController = null;
  let candidate = null;

  const transition = (next) => {
    state = next;
    publish?.(state);
    return state;
  };

  async function checkOnce({ force = false } = {}) {
    if (force && state.status !== "downloading" && state.status !== "installing") checked = false;
    if (state.status === "disabled" || checked) return state;
    const generation = ++checkGeneration;
    checked = true;
    transition({ status: "checking" });
    try {
      const release = await deps.fetchRelease();
      if (generation !== checkGeneration) return state;
      const version = releaseVersion(release?.tag_name);
      if (compareVersions(version, currentVersion) <= 0) {
        candidate = null;
        return transition({ status: "up-to-date" });
      }
      const assetName = releaseAssetName(version, platform, arch);
      if (!assetName) return transition({ status: "disabled" });
      const assets = Array.isArray(release?.assets) ? release.assets : [];
      const asset = assets.find((item) => item?.name === assetName);
      const checksums = assets.find((item) => item?.name === "checksums.txt");
      if (!asset?.browser_download_url || !checksums?.browser_download_url) {
        throw new Error(`Release v${version} is missing ${assetName} or checksums.txt`);
      }
      candidate = {
        version,
        assetName,
        assetUrl: validateReleaseAssetUrl(asset.browser_download_url, version, assetName),
        checksumsUrl: validateReleaseAssetUrl(checksums.browser_download_url, version, "checksums.txt"),
      };
      logger?.info("launcher.update_available", { currentVersion, version, platform, arch });
      return transition({ status: "available", version });
    } catch (error) {
      if (generation !== checkGeneration) return state;
      checked = false;
      const message = error instanceof Error ? error.message : String(error);
      logger?.warn("launcher.update_check_failed", { message });
      return transition({ status: "error", message });
    }
  }

  async function beginInstall() {
    if (pending) throw new Error("An update is already being prepared");
    if (state.status !== "available" || !candidate) throw new Error("No launcher update is available");
    const available = candidate;
    pendingAbortController = new AbortController();
    const signal = pendingAbortController.signal;
    pending = (async () => {
      transition({ status: "downloading", version: available.version });
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-update-"));
      try {
        const checksums = await deps.downloadText(available.checksumsUrl, { signal });
        const expected = expectedChecksum(checksums, available.assetName);
        const assetPath = path.join(tempRoot, available.assetName);
        await deps.downloadFile(available.assetUrl, assetPath, {
          signal,
          onProgress: ({ receivedBytes, totalBytes }) => {
            transition({ status: "downloading", version: available.version, receivedBytes, totalBytes });
          },
        });
        const actual = deps.sha256(assetPath);
        if (actual !== expected) throw new Error(`SHA-256 verification failed for ${available.assetName}`);

        const stagingRoot = path.join(tempRoot, "stage");
        if (platform === "darwin") deps.extractMac(assetPath, stagingRoot);
        if (platform === "linux") {
          fs.chmodSync(assetPath, 0o755);
          const runnerSource = deps.linuxRunnerSource();
          fs.copyFileSync(runnerSource, path.join(tempRoot, "linux-appimage-runner.sh"));
          fs.chmodSync(path.join(tempRoot, "linux-appimage-runner.sh"), 0o755);
        }

        const workerPath = path.join(tempRoot, "update-worker.cjs");
        fs.copyFileSync(path.join(__dirname, "update-worker.cjs"), workerPath);
        fs.copyFileSync(path.join(__dirname, "update-ready.cjs"), path.join(tempRoot, "update-ready.cjs"));
        fs.copyFileSync(path.join(__dirname, "update-recovery.cjs"), path.join(tempRoot, "update-recovery.cjs"));
        fs.copyFileSync(path.join(__dirname, "update-progress.cjs"), path.join(tempRoot, "update-progress.cjs"));
        const job = buildJob({
          version: available.version,
          platform,
          executablePath,
          assetPath,
          stagingRoot,
          tempRoot,
          logPath: path.join(logsDirectory, "update-worker.log"),
        });
        const jobPath = path.join(tempRoot, "job.json");
        fs.writeFileSync(jobPath, `${JSON.stringify(job)}\n`, { mode: 0o600 });
        const child = deps.spawnWorker(runtimeExecutable, workerPath, jobPath);
        if (!Number.isInteger(child?.pid) || child.pid <= 0) throw new Error("The update worker did not start");
        child.unref?.();
        logger?.info("launcher.update_worker_started", { pid: child.pid, version: available.version });
        transition({ status: "installing", version: available.version });
        return { child, tempRoot, version: available.version };
      } catch (error) {
        fs.rmSync(tempRoot, { recursive: true, force: true });
        transition({ status: "available", version: available.version });
        throw error;
      }
    })();
    try {
      return await pending;
    } finally {
      pending = null;
      pendingAbortController = null;
    }
  }

  function cancelInstall(launch) {
    if (pendingAbortController && !pendingAbortController.signal.aborted) {
      pendingAbortController.abort(new Error("Update preparation cancelled"));
    }
    try { launch?.child?.kill(); } catch {}
    if (launch?.tempRoot) fs.rmSync(launch.tempRoot, { recursive: true, force: true });
    if (candidate) transition({ status: "available", version: candidate.version });
  }

  return {
    getState: () => state,
    checkOnce,
    beginInstall,
    cancelInstall,
  };
}

module.exports = {
  buildJob,
  checkedFetch,
  compareVersions,
  createUpdateController,
  downloadPublicFile,
  expectedChecksum,
  fetchPublicRelease,
  macApplicationPath,
  parseVersion,
  releaseAssetParts,
  releaseAssetName,
  releaseVersion,
  validateReleaseAssetUrl,
  windowsApplicationPath,
};
