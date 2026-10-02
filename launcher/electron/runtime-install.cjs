const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { renameAtomicFile } = require("./atomic-file.cjs");
const { runtimeBundlePaths } = require("./runtime-command.cjs");

const DEFAULT_SOURCE_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_SOURCE_WAIT_INTERVAL_MS = 50;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function bundleIdFor(files) {
  const digest = createHash("sha256");
  for (const file of files) {
    digest.update(file.path);
    digest.update("\0");
    digest.update(String(file.size));
    digest.update("\0");
    digest.update(file.sha256);
    digest.update("\0");
  }
  return digest.digest("hex");
}

function validateManifestPath(relativePath) {
  if (typeof relativePath !== "string"
    || relativePath.length === 0
    || relativePath === "manifest.json"
    || relativePath.includes("\\")
    || path.posix.isAbsolute(relativePath)
    || path.posix.normalize(relativePath) !== relativePath
    || relativePath.split("/").some(segment => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`Runtime manifest contains an unsafe file path: ${JSON.stringify(relativePath)}`);
  }
  return relativePath;
}

function readRuntimeManifest(runtimeRoot, { version, platform, arch, bundleId }) {
  const manifestPath = path.join(runtimeRoot, "manifest.json");
  if (!fs.existsSync(manifestPath)) throw new Error(`Runtime manifest is missing: ${manifestPath}`);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Runtime manifest is invalid: ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const expectedLauncher = `bin/${platform === "win32" ? "codex-chatgpt-web.cmd" : "codex-chatgpt-web"}`;
  if (manifest?.schemaVersion !== 2
    || manifest.appVersion !== version
    || manifest.platform !== platform
    || manifest.arch !== arch
    || manifest.launcher !== expectedLauncher
    || manifest.entrypoint !== "app/cli.js"
    || typeof manifest.bunVersion !== "string"
    || typeof manifest.playwright !== "string"
    || !SHA256_PATTERN.test(manifest.bundleId)
    || (bundleId && manifest.bundleId !== bundleId)
    || !Array.isArray(manifest.files)
    || manifest.files.length === 0) {
    const received = manifest && typeof manifest === "object" ? {
      schemaVersion: manifest.schemaVersion,
      appVersion: manifest.appVersion,
      bundleId: manifest.bundleId,
      bunVersion: manifest.bunVersion,
      platform: manifest.platform,
      arch: manifest.arch,
      launcher: manifest.launcher,
      entrypoint: manifest.entrypoint,
      playwright: manifest.playwright,
      fileCount: Array.isArray(manifest.files) ? manifest.files.length : null,
    } : manifest;
    throw new Error(
      `Runtime bundle identity mismatch: expected ${version} ${platform}/${arch}, received ${JSON.stringify(received)}`,
    );
  }

  let previousPath = null;
  const files = manifest.files.map((file, index) => {
    if (!file || typeof file !== "object"
      || !Number.isSafeInteger(file.size)
      || file.size < 0
      || !SHA256_PATTERN.test(file.sha256)) {
      throw new Error(`Runtime manifest contains an invalid file record at index ${index}`);
    }
    const relativePath = validateManifestPath(file.path);
    if (previousPath !== null && comparePaths(previousPath, relativePath) >= 0) {
      throw new Error(`Runtime manifest file paths are not unique and sorted: ${relativePath}`);
    }
    previousPath = relativePath;
    return { path: relativePath, size: file.size, sha256: file.sha256 };
  });
  if (bundleIdFor(files) !== manifest.bundleId) {
    throw new Error(`Runtime manifest bundleId does not match its file records: ${manifestPath}`);
  }
  return { ...manifest, files };
}

function runtimeFilePaths(runtimeRoot) {
  const paths = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => comparePaths(left.name, right.name))) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(runtimeRoot, absolutePath).split(path.sep).join("/");
      if (relativePath === "manifest.json") continue;
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      paths.push(relativePath);
    }
  };
  visit(runtimeRoot);
  return paths.sort(comparePaths);
}

function validateRuntimeFile(runtimeRoot, canonicalRoot, file) {
  const absolutePath = path.join(runtimeRoot, ...file.path.split("/"));
  let metadata;
  try {
    metadata = fs.statSync(absolutePath);
  } catch {
    throw new Error(`Runtime bundle file is missing: ${absolutePath}`);
  }
  if (!metadata.isFile()) throw new Error(`Runtime bundle entry is not a file: ${absolutePath}`);
  if (fs.lstatSync(absolutePath).isSymbolicLink()) {
    const target = fs.realpathSync(absolutePath);
    if (target !== canonicalRoot && !target.startsWith(`${canonicalRoot}${path.sep}`)) {
      throw new Error(`Runtime bundle symlink escapes the bundle: ${absolutePath}`);
    }
  }
  if (metadata.size !== file.size) {
    throw new Error(`Runtime bundle file size mismatch: ${absolutePath}`);
  }
  const sha256 = createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex");
  if (sha256 !== file.sha256) {
    throw new Error(`Runtime bundle file checksum mismatch: ${absolutePath}`);
  }
}

function inspectRuntimeBundle(runtimeRoot, identity) {
  const manifest = readRuntimeManifest(runtimeRoot, identity);
  const expectedPaths = manifest.files.map(file => file.path);
  const expectedSet = new Set(expectedPaths);
  const paths = runtimeBundlePaths(runtimeRoot, identity.platform);
  for (const required of [
    paths.executable,
    paths.entrypoint,
    path.join(runtimeRoot, "app", "browser-helper.cjs"),
    path.join(runtimeRoot, ...manifest.launcher.split("/")),
  ]) {
    const relativePath = path.relative(runtimeRoot, required).split(path.sep).join("/");
    if (!expectedSet.has(relativePath)) {
      throw new Error(`Runtime manifest does not declare required file: ${required}`);
    }
  }

  const actualPaths = runtimeFilePaths(runtimeRoot);
  const actualSet = new Set(actualPaths);
  const missing = expectedPaths.find(relativePath => !actualSet.has(relativePath));
  if (missing) throw new Error(`Runtime bundle file is missing: ${path.join(runtimeRoot, ...missing.split("/"))}`);
  const unexpected = actualPaths.find(relativePath => !expectedSet.has(relativePath));
  if (unexpected) {
    throw new Error(`Runtime bundle contains an unmanifested file: ${path.join(runtimeRoot, ...unexpected.split("/"))}`);
  }
  if (actualPaths.length !== expectedPaths.length) {
    throw new Error(`Runtime bundle file count mismatch: expected ${expectedPaths.length}, received ${actualPaths.length}`);
  }

  const canonicalRoot = fs.realpathSync(runtimeRoot);
  for (const file of manifest.files) validateRuntimeFile(runtimeRoot, canonicalRoot, file);
  if (identity.platform !== "win32" && (fs.statSync(paths.executable).mode & 0o111) === 0) {
    throw new Error(`Bundled Bun runtime is not executable: ${paths.executable}`);
  }
  return { manifest, runtimeRoot: paths.runtimeRoot };
}

function validateRuntimeBundle(runtimeRoot, identity) {
  return inspectRuntimeBundle(runtimeRoot, identity).runtimeRoot;
}

async function waitForPackagedRuntimeSource({
  app,
  resourcesPath,
  timeoutMs = DEFAULT_SOURCE_WAIT_TIMEOUT_MS,
  intervalMs = DEFAULT_SOURCE_WAIT_INTERVAL_MS,
}) {
  if (!app.isPackaged) return null;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error("Packaged runtime source wait requires non-negative timeoutMs and positive intervalMs");
  }
  const source = path.join(resourcesPath, "runtime");
  const identity = {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
  };
  const deadline = Date.now() + timeoutMs;
  let lastError;
  for (;;) {
    try {
      return validateRuntimeBundle(source, identity);
    } catch (error) {
      lastError = error;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, remaining)));
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Packaged runtime did not fully materialize within ${timeoutMs}ms: ${detail}`);
}

function ensurePackagedRuntime({ app, coreHome, resourcesPath }) {
  if (!app.isPackaged) return null;
  const identity = {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
  };
  const source = path.join(resourcesPath, "runtime");
  const sourceBundle = inspectRuntimeBundle(source, identity);
  const expectedIdentity = { ...identity, bundleId: sourceBundle.manifest.bundleId };
  const versionsRoot = path.join(coreHome, "versions");
  const destination = path.join(
    versionsRoot,
    `${identity.version}-${identity.platform}-${identity.arch}`,
  );
  if (fs.existsSync(destination)) {
    try {
      return validateRuntimeBundle(destination, expectedIdentity);
    } catch {
      // A terminated installer or external cleanup can leave a version directory present but
      // incomplete. Rebuild the launcher-owned bundle transactionally from the signed package.
    }
  }

  fs.mkdirSync(versionsRoot, { recursive: true, mode: 0o700 });
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  const previous = `${destination}.previous-${process.pid}-${Date.now()}`;
  let previousMoved = false;
  try {
    fs.cpSync(source, temporary, {
      recursive: true,
      errorOnExist: true,
      force: false,
      verbatimSymlinks: true,
    });
    validateRuntimeBundle(temporary, expectedIdentity);
    if (fs.existsSync(destination)) {
      renameAtomicFile(destination, previous);
      previousMoved = true;
    }
    try {
      renameAtomicFile(temporary, destination);
      validateRuntimeBundle(destination, expectedIdentity);
    } catch (error) {
      fs.rmSync(destination, { recursive: true, force: true });
      if (previousMoved) {
        try {
          renameAtomicFile(previous, destination);
          previousMoved = false;
        } catch (restoreError) {
          throw new Error(
            `Runtime replacement failed: ${error instanceof Error ? error.message : String(error)}`
            + `; previous runtime restoration failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
          );
        }
      }
      throw error;
    }
    if (previousMoved) {
      fs.rmSync(previous, { recursive: true, force: true });
      previousMoved = false;
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
    if (previousMoved && fs.existsSync(previous) && !fs.existsSync(destination)) {
      renameAtomicFile(previous, destination);
      previousMoved = false;
    }
  }
  try { fs.chmodSync(destination, 0o700); } catch {}
  return validateRuntimeBundle(destination, expectedIdentity);
}

const RUNTIME_VERSION_NAME = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.]+))?$/;
const RUNTIME_LEFTOVER_KIND = /^\.(tmp|previous|prune)-\d+-\d+$/;
const RUNTIME_LEFTOVER_MIN_AGE_MS = 60 * 60_000;
const RUNTIME_DIRECTORY_BUSY_CODES = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY", "EEXIST"]);

function parseRuntimeVersion(version) {
  const match = RUNTIME_VERSION_NAME.exec(version);
  if (!match) return null;
  return { parts: match.slice(1, 4).map(Number), prerelease: match[4] ?? null };
}

function compareRuntimeVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left.parts[index] !== right.parts[index]) return left.parts[index] - right.parts[index];
  }
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}

async function removeRuntimeDirectory(versionsRoot, name, now) {
  const directory = path.join(versionsRoot, name);
  let doomed = directory;
  if (!name.includes(".prune-")) {
    // Rename first: a bundle still in use refuses the rename, so it is never left half-deleted
    // under its own name.
    doomed = path.join(versionsRoot, `${name}.prune-${process.pid}-${now}`);
    try {
      await fs.promises.rename(directory, doomed);
    } catch (error) {
      if (RUNTIME_DIRECTORY_BUSY_CODES.has(error?.code)) return false;
      throw error;
    }
  }
  try {
    await fs.promises.rm(doomed, { recursive: true, force: true, maxRetries: 2 });
    return true;
  } catch (error) {
    // The renamed remainder is a .prune- leftover that the next start removes.
    if (RUNTIME_DIRECTORY_BUSY_CODES.has(error?.code)) return false;
    throw error;
  }
}

// 02.10: every update copied a runtime bundle (~180 MB on Windows) into versions/ and nothing ever
// removed one; a single Windows install held 81 of them, about 14 GB. Keep the running version and
// the newest one below it, so returning to the previous release does not copy it again. Only names
// this file creates are touched: `<version>-<platform>-<arch>` and its .tmp-/.previous-/.prune-
// leftovers. Install leftovers younger than an hour may belong to a running install and stay.
async function pruneRuntimeVersions({ versionsRoot, version, platform, arch, now = Date.now() }) {
  const current = parseRuntimeVersion(version);
  if (!current) throw new Error(`Cannot prune runtimes around an unparseable version: ${version}`);
  const suffix = `-${platform}-${arch}`;
  let entries;
  try {
    entries = await fs.promises.readdir(versionsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { removed: 0, busy: 0, kept: [] };
    throw error;
  }
  const older = [];
  const doomed = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const bundleEnd = entry.name.indexOf(suffix);
    if (bundleEnd <= 0) continue;
    const bundleVersion = parseRuntimeVersion(entry.name.slice(0, bundleEnd));
    if (!bundleVersion) continue;
    const rest = entry.name.slice(bundleEnd + suffix.length);
    if (rest === "") {
      const order = compareRuntimeVersions(bundleVersion, current);
      if (order === 0) continue;
      if (order < 0) older.push({ name: entry.name, version: bundleVersion });
      else doomed.push(entry.name);
      continue;
    }
    const leftover = RUNTIME_LEFTOVER_KIND.exec(rest);
    if (!leftover) continue;
    if (leftover[1] !== "prune") {
      const { mtimeMs } = await fs.promises.stat(path.join(versionsRoot, entry.name));
      if (now - mtimeMs < RUNTIME_LEFTOVER_MIN_AGE_MS) continue;
    }
    doomed.push(entry.name);
  }
  older.sort((left, right) => compareRuntimeVersions(right.version, left.version));
  const previous = older.shift();
  doomed.push(...older.map(bundle => bundle.name));
  let removed = 0;
  let busy = 0;
  for (const name of doomed.sort()) {
    if (await removeRuntimeDirectory(versionsRoot, name, now)) removed += 1;
    else busy += 1;
  }
  return { removed, busy, kept: [`${version}${suffix}`, ...(previous ? [previous.name] : [])] };
}

module.exports = {
  ensurePackagedRuntime,
  pruneRuntimeVersions,
  validateRuntimeBundle,
  waitForPackagedRuntimeSource,
};
