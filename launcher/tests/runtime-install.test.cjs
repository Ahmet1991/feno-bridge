const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runtimeInvocation } = require("../electron/runtime-command.cjs");
const {
  ensurePackagedRuntime,
  ensurePackagedRuntimeAsync,
  inspectRuntimeMetadata,
  inspectRuntimeSource,
  pruneRuntimeVersions,
  validateRuntimeBundle,
  waitForPackagedRuntimeSource,
} = require("../electron/runtime-install.cjs");

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function manifestFiles(source) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => comparePaths(left.name, right.name))) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(source, absolutePath).split(path.sep).join("/");
      if (relativePath === "manifest.json") continue;
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      const content = fs.readFileSync(absolutePath);
      files.push({
        path: relativePath,
        size: content.byteLength,
        sha256: createHash("sha256").update(content).digest("hex"),
      });
    }
  };
  visit(source);
  return files.sort((left, right) => comparePaths(left.path, right.path));
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

function writeRuntimeManifest(source, version = "0.2.0") {
  const files = manifestFiles(source);
  fs.writeFileSync(path.join(source, "manifest.json"), `${JSON.stringify({
    schemaVersion: 2,
    appVersion: version,
    bundleId: bundleIdFor(files),
    bunVersion: "1.4.0",
    platform: process.platform,
    arch: process.arch,
    launcher: `bin/${process.platform === "win32" ? "codex-chatgpt-web.cmd" : "codex-chatgpt-web"}`,
    entrypoint: "app/cli.js",
    playwright: "1.62.0",
    files,
  })}\n`);
}

function runtimeFixture(root, version = "0.2.0") {
  const source = path.join(root, "resources", "runtime");
  const executable = path.join(source, "runtime", process.platform === "win32" ? "bun.exe" : "bun");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.mkdirSync(path.join(source, "app"), { recursive: true });
  fs.writeFileSync(executable, "bun");
  for(const name of require('../electron/private-acl-location.cjs').names){
    fs.writeFileSync(path.join(source,'runtime',name),name);
  }
  if (process.platform !== "win32") fs.chmodSync(executable, 0o755);
  fs.writeFileSync(path.join(source, "app", "cli.js"), "cli");
  fs.writeFileSync(path.join(source, "app", "browser-helper.cjs"), "helper");
  fs.mkdirSync(path.join(source, "app", "node_modules", "zod", "v4"), { recursive: true });
  fs.writeFileSync(path.join(source, "app", "node_modules", "zod", "v4", "index.js"), "zod-v4");
  if (process.platform !== "win32") {
    fs.mkdirSync(path.join(source, "app", "node_modules", ".bin"), { recursive: true });
    fs.symlinkSync("../zod/v4/index.js", path.join(source, "app", "node_modules", ".bin", "zod-v4"));
  }
  fs.mkdirSync(path.join(source, "app", "node_modules", "nested-dependency", "dist", "runtime"), { recursive: true });
  fs.writeFileSync(
    path.join(source, "app", "node_modules", "nested-dependency", "dist", "runtime", "worker.js"),
    "nested-worker",
  );
  fs.mkdirSync(path.join(source, "bin"), { recursive: true });
  fs.writeFileSync(
    path.join(source, "bin", process.platform === "win32" ? "codex-chatgpt-web.cmd" : "codex-chatgpt-web"),
    "launcher",
  );
  writeRuntimeManifest(source, version);
  return path.join(root, "resources");
}

test('verified receipt defers hashes on repeated startup and detects later corruption', async (t) => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-fast-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const resourcesPath=runtimeFixture(root),coreHome=path.join(root,'core-home');
  const app={isPackaged:true,getVersion:()=> '0.2.0'};
  const identity={version:'0.2.0',platform:process.platform,arch:process.arch};
  const source=path.join(resourcesPath,'runtime');
  let saved=null,hashes=0;
  const phases=[];
  const receipt={save:async data=>{saved=data;},invalidate:async()=>{saved=null;}};
  const inspect=async (...args)=>{hashes++;return inspectRuntimeSource(...args);};
  const begin=phase=>()=>phases.push(phase);
  const options={app,coreHome,resourcesPath,receipt,inspect,begin};
  const first=await ensurePackagedRuntimeAsync({...options,sourceBundle:await inspectRuntimeMetadata(source,identity)});
  assert.ok(saved);assert.ok(hashes>=2);assert.equal(first.verifyInBackground,null);
  hashes=0;
  const next=await ensurePackagedRuntimeAsync({...options,previousReceipt:saved,sourceBundle:await inspectRuntimeMetadata(source,identity)});
  assert.equal(next.runtimeRoot,first.runtimeRoot);assert.equal(hashes,0);assert.equal(typeof next.verifyInBackground,'function');
  assert.ok(phases.includes('runtime_install_metadata'));
  await next.verifyInBackground();assert.equal(hashes,2);assert.ok(phases.includes('runtime_background_hash'));
  fs.writeFileSync(path.join(next.runtimeRoot,'app','cli.js'),'bad');
  await assert.rejects(next.verifyInBackground(),/checksum mismatch|changed/);assert.equal(saved,null);
  const repaired=await ensurePackagedRuntimeAsync({...options,sourceBundle:await inspectRuntimeMetadata(source,identity)});
  assert.equal(fs.readFileSync(path.join(repaired.runtimeRoot,'app','cli.js'),'utf8'),'cli');
  const helper=path.join(repaired.runtimeRoot,'runtime','private-acl-cli.cjs');
  const fast=await ensurePackagedRuntimeAsync({...options,previousReceipt:saved,sourceBundle:await inspectRuntimeMetadata(source,identity)});
  fs.writeFileSync(helper,'tampered');
  await assert.rejects(fast.verifyInBackground(),/checksum mismatch|changed|size mismatch/);
  assert.equal(saved,null);
});

test("packaged runtime is installed once into a durable versioned directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-install-"));
  const resourcesPath = runtimeFixture(root);
  const coreHome = path.join(root, "core-home");
  const app = { isPackaged: true, getVersion: () => "0.2.0" };
  try {
    const installed = ensurePackagedRuntime({ app, coreHome, resourcesPath });
    assert.equal(installed, path.join(coreHome, "versions", `0.2.0-${process.platform}-${process.arch}`));
    assert.equal(fs.readFileSync(path.join(installed, "app", "cli.js"), "utf8"), "cli");
    assert.equal(ensurePackagedRuntime({ app, coreHome, resourcesPath }), installed);

    const invocation = runtimeInvocation({
      app,
      sourceRoot: root,
      installedRuntimeRoot: installed,
      args: ["serve"],
    });
    assert.equal(invocation.cwd, installed);
    assert.equal(invocation.args[0], path.join(installed, "app", "cli.js"));
    assert.equal(invocation.args[1], "serve");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("packaged runtime installation rejects a platform or version mismatch", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-mismatch-"));
  const resourcesPath = runtimeFixture(root, "0.1.0");
  try {
    assert.throws(
      () => ensurePackagedRuntime({
        app: { isPackaged: true, getVersion: () => "0.2.0" },
        coreHome: path.join(root, "core-home"),
        resourcesPath,
      }),
      /identity mismatch/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("packaged runtime rejects a missing executable before creating durable state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-missing-"));
  const resourcesPath = runtimeFixture(root);
  const coreHome = path.join(root, "core-home");
  const executable = path.join(
    resourcesPath,
    "runtime",
    "runtime",
    process.platform === "win32" ? "bun.exe" : "bun",
  );
  fs.rmSync(executable);
  try {
    assert.throws(
      () => ensurePackagedRuntime({
        app: { isPackaged: true, getVersion: () => "0.2.0" },
        coreHome,
        resourcesPath,
      }),
      /Runtime bundle file is missing/,
    );
    assert.equal(fs.existsSync(coreHome), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const relativePath of [
  ["app", "node_modules", "zod", "v4", "index.js"],
  ["app", "node_modules", "nested-dependency", "dist", "runtime", "worker.js"],
]) {
  test(`packaged runtime rejects a missing nested dependency: ${relativePath.join("/")}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-dependency-"));
    const resourcesPath = runtimeFixture(root);
    const coreHome = path.join(root, "core-home");
    fs.rmSync(path.join(resourcesPath, "runtime", ...relativePath));
    try {
      assert.throws(
        () => ensurePackagedRuntime({
          app: { isPackaged: true, getVersion: () => "0.2.0" },
          coreHome,
          resourcesPath,
        }),
        /Runtime bundle file is missing/,
      );
      assert.equal(fs.existsSync(coreHome), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("packaged runtime rejects same-count content corruption", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-corrupt-"));
  const resourcesPath = runtimeFixture(root);
  const coreHome = path.join(root, "core-home");
  const dependency = path.join(resourcesPath, "runtime", "app", "node_modules", "zod", "v4", "index.js");
  fs.writeFileSync(dependency, "bad-v4");
  try {
    assert.throws(
      () => ensurePackagedRuntime({
        app: { isPackaged: true, getVersion: () => "0.2.0" },
        coreHome,
        resourcesPath,
      }),
      /checksum mismatch/,
    );
    assert.equal(fs.existsSync(coreHome), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("packaged source hashes files with bounded parallel asynchronous reads", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-parallel-"));
  const resourcesPath = runtimeFixture(root);
  const read = fs.promises.readFile;
  let active=0, peak=0, count=0;
  fs.promises.readFile=async function(...args){active++;count++;peak=Math.max(peak,active);try{return await read.apply(this,args);}finally{active--;}};
  try {
    await waitForPackagedRuntimeSource({app:{isPackaged:true,getVersion:()=>"0.2.0"},resourcesPath});
    assert.ok(count>=6);assert.ok(peak>1 && peak<=8);
  } finally {fs.promises.readFile=read;fs.rmSync(root,{recursive:true,force:true});}
});

test("packaged runtime source wait accepts a delayed final dependency within its bound", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-delayed-"));
  const resourcesPath = runtimeFixture(root);
  const delayed = path.join(
    resourcesPath,
    "runtime",
    "app",
    "node_modules",
    "nested-dependency",
    "dist",
    "runtime",
    "worker.js",
  );
  const content = fs.readFileSync(delayed);
  fs.rmSync(delayed);
  const materialize = setTimeout(() => fs.writeFileSync(delayed, content), 40);
  try {
    assert.equal(
      await waitForPackagedRuntimeSource({
        app: { isPackaged: true, getVersion: () => "0.2.0" },
        resourcesPath,
        timeoutMs: 500,
        intervalMs: 10,
      }),
      path.join(resourcesPath, "runtime"),
    );
  } finally {
    clearTimeout(materialize);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("packaged runtime source wait fails closed when materialization exceeds its bound", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-timeout-"));
  const resourcesPath = runtimeFixture(root);
  fs.rmSync(path.join(resourcesPath, "runtime", "app", "node_modules", "zod", "v4", "index.js"));
  try {
    await assert.rejects(
      waitForPackagedRuntimeSource({
        app: { isPackaged: true, getVersion: () => "0.2.0" },
        resourcesPath,
        timeoutMs: 30,
        intervalMs: 5,
      }),
      /did not fully materialize within 30ms.*Runtime bundle file is missing/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("150 source inspections report waiting only once",async()=>{
  let attempts=0;
  const events=[];
  const {createBootReporter}=require("../electron/startup-timing.cjs");
  const reporter=createBootReporter({info:(event,details)=>events.push({event,...details})});
  events.length=0;
  const done=reporter.begin("runtime_source");
  const bundle={runtimeRoot:"fixture"};
  assert.equal(await waitForPackagedRuntimeSource({
    app:{isPackaged:true,getVersion:()=>"5.1.28"},resourcesPath:".",
    timeoutMs:10000,intervalMs:1,returnBundle:true,
    inspect:async()=>{if(++attempts<150)throw Error("not ready");return bundle;},
    onWait:ms=>reporter.wait("runtime_source","source_materializing",ms),
  }),bundle);
  done();
  assert.equal(attempts,150);assert.equal(events.length,3);
  const main=fs.readFileSync(path.join(__dirname,"../electron/main.cjs"),"utf8");
  assert.match(main,/inspect:\s*receipt\?inspectRuntimeMetadata:inspectRuntimeSource/);
});

test("packaged runtime transactionally repairs an incomplete installed bundle", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-repair-"));
  const resourcesPath = runtimeFixture(root);
  const coreHome = path.join(root, "core-home");
  const app = { isPackaged: true, getVersion: () => "0.2.0" };
  try {
    const installed = ensurePackagedRuntime({ app, coreHome, resourcesPath });
    const dependency = path.join(
      installed,
      "app",
      "node_modules",
      "nested-dependency",
      "dist",
      "runtime",
      "worker.js",
    );
    fs.rmSync(dependency);
    fs.writeFileSync(path.join(installed, "corrupt.partial"), "interrupted copy");

    assert.equal(ensurePackagedRuntime({ app, coreHome, resourcesPath }), installed);
    assert.equal(fs.readFileSync(dependency, "utf8"), "nested-worker");
    assert.equal(fs.existsSync(path.join(installed, "corrupt.partial")), false);
    assert.deepEqual(
      fs.readdirSync(path.dirname(installed)).filter(name => name.includes(".previous-") || name.includes(".tmp-")),
      [],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("failed candidate validation preserves the previous validated runtime", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-preserve-"));
  const resourcesPath = runtimeFixture(root);
  const coreHome = path.join(root, "core-home");
  const app = { isPackaged: true, getVersion: () => "0.2.0" };
  const originalCopy = fs.cpSync;
  try {
    const installed = ensurePackagedRuntime({ app, coreHome, resourcesPath });
    const source = path.join(resourcesPath, "runtime");
    fs.writeFileSync(path.join(source, "app", "cli.js"), "new cli");
    writeRuntimeManifest(source);

    fs.cpSync = (from, to, options) => {
      originalCopy(from, to, options);
      fs.rmSync(path.join(to, "app", "node_modules", "zod", "v4", "index.js"));
    };
    assert.throws(
      () => ensurePackagedRuntime({ app, coreHome, resourcesPath }),
      /Runtime bundle file is missing/,
    );
    assert.equal(fs.readFileSync(path.join(installed, "app", "cli.js"), "utf8"), "cli");
    assert.equal(
      validateRuntimeBundle(installed, {
        version: "0.2.0",
        platform: process.platform,
        arch: process.arch,
      }),
      installed,
    );
    assert.deepEqual(
      fs.readdirSync(path.dirname(installed)).filter(name => name.includes(".previous-") || name.includes(".tmp-")),
      [],
    );
  } finally {
    fs.cpSync = originalCopy;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("packaged runtime replaces stale files when a release is refreshed under the same version", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-refresh-"));
  const resourcesPath = runtimeFixture(root, "0.2.0");
  const coreHome = path.join(root, "core-home");
  const app = { isPackaged: true, getVersion: () => "0.2.0" };
  try {
    const installed = ensurePackagedRuntime({ app, coreHome, resourcesPath });
    fs.writeFileSync(path.join(installed, "old-release-marker"), "old");

    const source = path.join(resourcesPath, "runtime");
    fs.writeFileSync(path.join(source, "app", "cli.js"), "new cli");
    writeRuntimeManifest(source);

    assert.equal(ensurePackagedRuntime({ app, coreHome, resourcesPath }), installed);
    assert.equal(fs.readFileSync(path.join(installed, "app", "cli.js"), "utf8"), "new cli");
    assert.equal(fs.existsSync(path.join(installed, "old-release-marker")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("old runtime bundles are pruned down to the running version and the one before it", async (t) => {
  const versionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "feno-runtime-prune-"));
  t.after(() => fs.rmSync(versionsRoot, { recursive: true, force: true }));
  const now = Date.now();
  const make = (name, ageMs = 2 * 60 * 60_000) => {
    const directory = path.join(versionsRoot, name);
    fs.mkdirSync(path.join(directory, "app"), { recursive: true });
    fs.writeFileSync(path.join(directory, "app", "cli.js"), name);
    const at = new Date(now - ageMs);
    fs.utimesSync(directory, at, at);
  };
  for (const name of [
    "5.0.9-win32-x64",
    "5.0.10-win32-x64",
    "5.0.31-rc.1-win32-x64",
    "5.0.72-win32-x64",
    "5.0.73-win32-x64",
    // A later release the user stepped back from.
    "6.1.3-win32-x64",
    // Install leftovers: old ones go, a fresh one may belong to a running install.
    "5.0.11-win32-x64.tmp-7976-1789682834720",
    "5.0.4-win32-x64.previous-36660-1788909059133",
    "5.0.30-win32-x64.prune-1-2",
    // Not ours: another architecture, a hand-made backup, an unrelated folder.
    "5.0.10-win32-arm64",
    "5.0.4-win32-x64.pre-nspath",
    "notes",
  ]) make(name);
  make("5.0.73-win32-x64.tmp-1-2", 60_000);
  fs.writeFileSync(path.join(versionsRoot, "5.0.8-win32-x64"), "a file, not a bundle");

  const result = await pruneRuntimeVersions({ versionsRoot, version: "5.0.73", platform: "win32", arch: "x64", now });
  assert.deepEqual(result, { removed: 7, busy: 0, kept: ["5.0.73-win32-x64", "5.0.72-win32-x64"] });
  assert.deepEqual(fs.readdirSync(versionsRoot).sort(), [
    "5.0.10-win32-arm64",
    "5.0.4-win32-x64.pre-nspath",
    "5.0.72-win32-x64",
    "5.0.73-win32-x64",
    "5.0.73-win32-x64.tmp-1-2",
    "5.0.8-win32-x64",
    "notes",
  ]);
  assert.equal(fs.readFileSync(path.join(versionsRoot, "5.0.73-win32-x64", "app", "cli.js"), "utf8"), "5.0.73-win32-x64");

  // A second start has nothing left to remove; a first install has no versions folder at all.
  assert.deepEqual(
    await pruneRuntimeVersions({ versionsRoot, version: "5.0.73", platform: "win32", arch: "x64", now }),
    { removed: 0, busy: 0, kept: ["5.0.73-win32-x64", "5.0.72-win32-x64"] },
  );
  assert.deepEqual(
    await pruneRuntimeVersions({ versionsRoot: path.join(versionsRoot, "missing"), version: "5.0.73", platform: "win32", arch: "x64", now }),
    { removed: 0, busy: 0, kept: [] },
  );
});

test("a runtime bundle that is still in use is left for the next start", async (t) => {
  const versionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "feno-runtime-prune-busy-"));
  t.after(() => fs.rmSync(versionsRoot, { recursive: true, force: true }));
  for (const name of ["5.0.70-linux-x64", "5.0.71-linux-x64", "5.0.72-linux-x64"]) {
    fs.mkdirSync(path.join(versionsRoot, name));
  }
  const rename = fs.promises.rename;
  t.after(() => { fs.promises.rename = rename; });
  fs.promises.rename = async (from, to) => {
    if (path.basename(from) === "5.0.70-linux-x64") throw Object.assign(new Error("in use"), { code: "EBUSY" });
    return rename(from, to);
  };
  const result = await pruneRuntimeVersions({ versionsRoot, version: "5.0.72", platform: "linux", arch: "x64" });
  assert.deepEqual(result, { removed: 0, busy: 1, kept: ["5.0.72-linux-x64", "5.0.71-linux-x64"] });
  assert.deepEqual(fs.readdirSync(versionsRoot).sort(), ["5.0.70-linux-x64", "5.0.71-linux-x64", "5.0.72-linux-x64"]);
});
