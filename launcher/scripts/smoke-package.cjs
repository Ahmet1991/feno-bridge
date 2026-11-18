const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { validateRuntimeBundle } = require("../electron/runtime-install.cjs");
const { stageWindowsSmoke } = require("./stage-windows-smoke.cjs");

const launcherRoot = path.resolve(__dirname, "..");
const artifactsDirectory = path.join(launcherRoot, "artifacts");
const launcherManifest = JSON.parse(
  fs.readFileSync(path.join(launcherRoot, "package.json"), "utf8"),
);
const expectedVersion = launcherManifest.version;
// The daemon deliberately refuses runtime commands installed beneath a system
// temp directory. Use an ignored workspace directory just like a durable install.
const smokeRoot = path.resolve(launcherRoot, "..", ".cache");
fs.mkdirSync(smokeRoot, { recursive: true });
const scratch = fs.mkdtempSync(path.join(smokeRoot, "codex-web-gpt-package-smoke-"));
const scratchTemp = path.join(scratch, "tmp");
fs.mkdirSync(scratchTemp);
const markerPath = path.join(scratch, "ready.json");
const coreHome = path.join(scratch, "core-home");
let macAppBundle;
let failed = false;

const WINDOWS_LAUNCHER_SMOKE_TIMEOUT_MS = 480_000;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || scratch,
    env: options.env || process.env,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: options.timeout || 45_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} failed with status ${result.status}: ${result.stderr?.trim() || result.stdout?.trim() || "no output"}`,
    );
  }
  return result;
}

function waitForFile(file, timeout=10_000) {
  const deadline=Date.now()+timeout;
  const sleeper=new Int32Array(new SharedArrayBuffer(4));
  while(!fs.existsSync(file)&&Date.now()<deadline)Atomics.wait(sleeper,0,0,100);
  if(!fs.existsSync(file))throw Error('Foreground sampler did not signal readiness');
}

function startForegroundSampler() {
  const compiler=['Framework64','Framework'].map(folder=>path.join(process.env.SystemRoot||'C:\\Windows','Microsoft.NET',folder,'v4.0.30319','csc.exe')).find(file=>fs.existsSync(file));
  if(!compiler)throw Error('Foreground sampler compiler missing');
  const library=path.join(scratch,'foreground.dll');
  run(compiler,['/nologo','/target:library','/out:'+library,'/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll',path.join(launcherRoot,'..','scripts','sample-browser-foreground.cs')]);
  const probe=spawn('powershell.exe',['-NoProfile','-Command','Add-Type -Path $env:FENO_FOCUS_PROBE; [ForegroundProbe]::RunPassive($env:FENO_FOCUS_DIRECTORY)'],{windowsHide:true,stdio:'ignore',env:{...process.env,FENO_FOCUS_PROBE:library,FENO_FOCUS_DIRECTORY:scratch}});
  const ready=path.join(scratch,'foreground-ready');
  const stop=path.join(scratch,'foreground-stop');
  const done=path.join(scratch,'foreground-done');
  try{waitForFile(ready);}catch(error){fs.writeFileSync(stop,'stop');probe.kill();throw error;}
  return () => {
    fs.writeFileSync(stop,'stop');
    try{waitForFile(done);}catch(error){probe.kill();throw error;}
    const expected=fs.readFileSync(ready,'utf8').trim();
    const rows=fs.readFileSync(path.join(scratch,'foreground.csv'),'utf8').trim().split(/\r?\n/).map(line=>line.split(','));
    const changes=rows.filter(row=>row[1]!==expected);
    const chromeSamples=rows.filter(row=>/^(chrome|msedge)$/i.test(row[3])).length;
    const bridgeSamples=rows.filter(row=>row[3].toLowerCase()===launcherManifest.build.productName.toLowerCase()).length;
    // Other apps can legitimately receive focus while this passive test runs.
    console.log('PACKAGED_FOREGROUND '+JSON.stringify({samples:rows.length,foregroundChanges:changes.length,chromeSamples,bridgeSamples,interactive:expected!=='0'}));
    if(expected==='0'||rows.length<5||chromeSamples||bridgeSamples)throw Error('Packaged launcher foreground check failed');
  };
}

function artifact(pattern, label) {
  const matches = fs.readdirSync(artifactsDirectory)
    .filter((name) => pattern.test(name))
    .sort();
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${label} in ${artifactsDirectory}; found ${matches.join(", ") || "none"}`);
  }
  return path.join(artifactsDirectory, matches[0]);
}

function smokeEnvironment() {
  return {
    ...process.env,
    TMPDIR: scratchTemp,
    TEMP: scratchTemp,
    TMP: scratchTemp,
    CODEX_WEB_GPT_LAUNCHER_DATA_DIR: path.join(scratch, "launcher-data"),
    CODEX_CHATGPT_WEB_HOME: coreHome,
    CODEX_WEB_GPT_DEV_HOME: path.join(scratch, "dev-home"),
    CODEX_HOME: path.join(scratch, "codex-home"),
    FENO_PC_COORDINATION_DIR: path.join(scratch, "coordination"),
    CODEX_WEB_GPT_DEFAULT_PORT: "18941",
    CODEX_WEB_GPT_SMOKE_FILE: markerPath,
  };
}

try {
  let executable;
  let command;
  let args;
  const env = smokeEnvironment();

  if (process.platform === "darwin") {
    const archive = artifact(/-mac-(?:arm64|x64)\.zip$/, "macOS launcher archive");
    const stage = path.join(scratch, "stage");
    fs.mkdirSync(stage);
    run("ditto", ["-x", "-k", archive, stage]);
    macAppBundle = path.join(stage, `${launcherManifest.build.productName}.app`);
    executable = path.join(macAppBundle, "Contents", "MacOS", launcherManifest.build.productName);
    command = executable;
    args = ["--launcher-smoke-test"];
  } else if (process.platform === "linux") {
    executable = artifact(/-linux-x64\.AppImage$/, "Linux AppImage");
    fs.chmodSync(executable, 0o755);
    run(path.join(launcherRoot, "scripts", "smoke-linux-appimage-symbols.sh"), [executable], {
      timeout: 120_000,
    });
    command = "xvfb-run";
    args = ["-a", executable, "--launcher-smoke-test"];
    env.APPIMAGE_EXTRACT_AND_RUN = "1";
  } else if (process.platform === "win32") {
    const installer = artifact(/-win-x64\.exe$/, "Windows installer");
    executable = stageWindowsSmoke({ installer, scratch, productName: launcherManifest.build.productName, run });
    const resources = path.join(path.dirname(executable), "resources");
    const runtime = path.join(resources, "runtime", "runtime");
    for (const name of ["pc-windows-helper", "chrome-native-host"]) {
      const actual = createHash("sha256").update(fs.readFileSync(path.join(runtime, name + ".exe"))).digest("hex");
      const expected = fs.readFileSync(path.join(runtime, name + ".sha256"), "utf8").trim();
      if (actual !== expected) throw new Error(name + " packaged SHA-256 mismatch");
      console.log("PACKAGED_HELPER_SHA256_OK " + name + " " + actual);
    }
    for (const file of ["manifest.json", "worker.js", "engine.js", "dom.js"]) {
      if (!fs.readFileSync(path.join(resources, "chrome-extension", file)).equals(fs.readFileSync(path.join(launcherRoot, "chrome-extension", file)))) {
        throw new Error("Packaged Chrome extension differs from source: " + file);
      }
    }
    const host = path.join(runtime, "chrome-native-host.exe");
    run(host, ["--manifest"]);
    const native = JSON.parse(fs.readFileSync(path.join(resources, "chrome-native-host.json"), "utf8"));
    if (native.name !== "com.feno.bridge.pc2" || native.path !== host || native.type !== "stdio"
      || JSON.stringify(native.allowed_origins) !== JSON.stringify(["chrome-extension://mcimkhafgpcecjdjjiljhljdkaggapfa/"])) {
      throw new Error("Packaged Chrome native host manifest mismatch");
    }
    console.log("PACKAGED_CHROME_EXTENSION_OK " + expectedVersion);
    command = executable;
    args = ["--launcher-smoke-test"];
  } else {
    throw new Error(`Unsupported package smoke platform: ${process.platform}`);
  }

  if (!fs.existsSync(executable)) throw new Error(`Packaged launcher executable is missing: ${executable}`);
  if (process.platform === "win32") {
    const logFile=path.join(env.CODEX_WEB_GPT_LAUNCHER_DATA_DIR,'logs','launcher.jsonl');
    const stopSampler=startForegroundSampler();
    try {
    for(let attempt=1;attempt<=2;attempt++){
      fs.rmSync(markerPath,{force:true});
      run(command, args, { env, timeout: WINDOWS_LAUNCHER_SMOKE_TIMEOUT_MS });
      const ready=JSON.parse(fs.readFileSync(markerPath,'utf8'));
      if(!ready.ok||!ready.runtimeStartupVerified||!ready.pcServiceStarted||ready.version!==expectedVersion)throw Error('Invalid smoke readiness marker on launch '+attempt);
      const events=fs.readFileSync(logFile,'utf8').trim().split(/\r?\n/).map(line=>JSON.parse(line));
      const boot=events.findLastIndex(event=>event.event==='launcher.boot_started');
      const phases=Object.fromEntries(events.slice(boot).filter(event=>event.event==='launcher.boot_phase_finished').map(event=>[event.detail.phase,event.detail.durationMs]));
      if(!Number.isFinite(phases.runtime_source)||!Number.isFinite(phases.runtime_install))throw Error('Missing runtime phase measurements');
      if(attempt===2&&!Number.isFinite(phases.runtime_background_hash))throw Error('Repeated launch did not use deferred verification');
      console.log('PACKAGED_STARTUP_TIMING '+JSON.stringify({attempt,phases,sourceAndInstallMs:phases.runtime_source+phases.runtime_install}));
    }
    } finally {stopSampler();}
  } else {
    run(command, args, { env });
  }
  if (!fs.existsSync(markerPath)) throw new Error("Packaged launcher did not write its readiness marker");
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  if (marker.ok !== true
    || marker.packaged !== true
    || marker.runtimeVerified !== true
    || marker.cdpStatus !== 200
    || marker.runtimeStartupVerified !== true
    || (process.platform === "win32" && marker.pcServiceStarted !== true)
    || marker.version !== expectedVersion
    || marker.platform !== process.platform) {
    throw new Error(`Unexpected packaged launcher marker: ${JSON.stringify(marker)}`);
  }
  const guidanceSource = path.join(launcherRoot, "..", "CHATGPT.md");
  const installedGuidance = path.join(env.CODEX_HOME, "skills", "feno-bridge-guide", "SKILL.md");
  if (!fs.existsSync(installedGuidance)
    || !fs.readFileSync(installedGuidance).equals(fs.readFileSync(guidanceSource))) {
    throw new Error("Packaged launcher did not install its current Feno Bridge guide");
  }
  const roundTripsGuidance = path.join(env.CODEX_HOME, "AGENTS.md");
  if (!fs.existsSync(roundTripsGuidance)
    || !fs.readFileSync(roundTripsGuidance, "utf8").includes("<!-- FENO BRIDGE FEWER ROUND TRIPS START -->")) {
    throw new Error("Packaged launcher did not install the fewer-round-trips guidance");
  }
  if (process.platform === "win32") {
    const globalGuidance = path.join(env.CODEX_HOME, "AGENTS.md");
    if (!fs.existsSync(globalGuidance)
      || !fs.readFileSync(globalGuidance, "utf8").includes("<!-- FENO BRIDGE WINDOWS COMPUTER USE START -->")) {
      throw new Error("Packaged Windows launcher did not install global Computer Use routing");
    }
    if (process.arch === "x64") {
      for (const tool of ["jq.exe", "hyperfine.exe"]) {
        if (!fs.existsSync(path.join(coreHome, "tools", tool))) {
          throw new Error(`Packaged Windows launcher did not install ${tool}`);
        }
      }
      if (!fs.readFileSync(globalGuidance, "utf8").includes("<!-- FENO BRIDGE CLI TOOLS START -->")) {
        throw new Error("Packaged Windows launcher did not point Codex at its CLI tools");
      }
    }
  }
  const installedRuntime = path.join(
    coreHome,
    "versions",
    `${expectedVersion}-${process.platform}-${process.arch}`,
  );
  const installedManifest = JSON.parse(
    fs.readFileSync(path.join(installedRuntime, "manifest.json"), "utf8"),
  );
  validateRuntimeBundle(installedRuntime, {
    version: expectedVersion,
    platform: process.platform,
    arch: process.arch,
  });
  if (installedManifest.schemaVersion !== 2
    || installedManifest.appVersion !== expectedVersion
    || installedManifest.platform !== process.platform
    || installedManifest.arch !== process.arch
    || !Array.isArray(installedManifest.files)
    || installedManifest.files.length === 0
    || !/^[a-f0-9]{64}$/.test(installedManifest.bundleId)) {
    throw new Error(`Packaged launcher installed the wrong durable runtime: ${JSON.stringify(installedManifest)}`);
  }
  process.stdout.write(`PACKAGED_LAUNCHER_SMOKE_OK ${process.platform}/${process.arch} ${JSON.stringify(marker)}\n`);
} catch (error) {
  failed = true;
  process.stderr.write(`Package smoke failed; isolated evidence retained at ${scratch}\n`);
  throw error;
} finally {
  try {
    if (macAppBundle) {
      const launchServices =
        "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
      run(
        launchServices,
        ["-u", macAppBundle],
      );
      run(launchServices, ["-gc"]);
    }
  } finally {
    try {
      if (!failed) fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } catch (error) {
      if (!(process.platform === "win32" && ["EPERM", "EBUSY", "ENOTEMPTY"].includes(error?.code))) {
        throw error;
      }
    }
  }
}
