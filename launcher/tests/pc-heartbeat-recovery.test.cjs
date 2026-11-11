const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { createPcConsentController } = require("../electron/pc-consent.cjs");

for (const failureMode of ["heartbeat", "quit publication"]) test(`actual local approval handler restarts heartbeats after ${failureMode} failure`, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pc-heartbeat-recovery-"));
  let now = 1_800_000_000_000;
  const timers = new Map();
  const context = vm.createContext({ require: createRequire(path.join(__dirname, "../electron/pc-consent-channel.cjs")), Buffer, process, fs, IS_DEV_PROFILE: false, module: { exports: {} },
    setInterval(callback) { const timer = { unref() {} }; timers.set(timer, callback); return timer; },
    clearInterval(timer) { timers.delete(timer); },
  });
  try {
    // Run the production channel helper with deterministic timers, real signed files.
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../electron/pc-consent-channel.cjs"), "utf8"), context);
    const writer = context.module.exports.createPcConsentChannel({ directory, clock: () => now });
    writer.start();
    context.suspendPcAccess = context.module.exports.suspendPcAccess;
    context.pcConsentController = createPcConsentController({ clock: () => now, confirmLocally: async () => true });
    context.pcConsentChannel = writer;
    context.pcConsentHeartbeat = null;
    context.pcApprovedScope = null;
    context.requireTrustedPcRenderer = () => {};
    let approve;
    context.handle = (_name, callback) => { approve = callback; };
    const main = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
    const helperStart = main.indexOf("function ensurePcConsentHeartbeat()");
    if (helperStart >= 0) {
      vm.runInContext(main.slice(helperStart, main.indexOf("function findFreePort()", helperStart)), context);
      vm.runInContext("ensurePcConsentHeartbeat();", context);
    } else {
      const start = main.indexOf("  pcConsentHeartbeat = setInterval(");
      const end = main.indexOf("  pcConsentHeartbeat.unref?.();", start);
      vm.runInContext(main.slice(start, end + "  pcConsentHeartbeat.unref?.();".length), context);
    }
    vm.runInContext(main.slice(main.indexOf('  handle("launcher:pc-approve",'), main.indexOf('  handle("launcher:pc-revoke",')), context);
    await approve({}, { durationMs: 60_000, roots: [directory], permissions: ["files.read"], allowedApps: [] });
    if (failureMode === "heartbeat") {
      const heartbeat = writer.heartbeat;
      writer.heartbeat = () => { throw new Error("transient channel write failure"); };
      for (const callback of [...timers.values()]) callback();
      writer.heartbeat = heartbeat;
    } else {
      Object.assign(context, { shutdownInProgress: false, exitCommitted: false, quitting: false,
        showMainWindow() {}, publishOperation() {} });
      const revoke = writer.revoke;
      writer.revoke = () => { throw new Error("transient revoke write failure"); };
      vm.runInContext(main.slice(main.indexOf("async function requestQuit()"), main.indexOf("async function start()")), context);
      assert.equal((await context.requestQuit()).ok, false);
      writer.revoke = revoke;
    }
    assert.equal(timers.size, failureMode === "heartbeat" ? 1 : 0,
      "a transient heartbeat failure must keep retrying without another approval");
    if (failureMode !== "heartbeat") {
      await approve({}, { durationMs: 60_000, roots: [directory], permissions: ["files.read"], allowedApps: [] });
      await approve({}, { durationMs: 60_000, roots: [directory], permissions: ["files.read"], allowedApps: [] });
    }
    now += 20_000;
    for (const callback of [...timers.values()]) callback();
    const { payload } = JSON.parse(fs.readFileSync(path.join(directory, "pc-consent-state.json"), "utf8"));
    assert.ok(now - payload.heartbeatAt <= 15_000, "reapproved access must keep publishing fresh signed heartbeats");
    assert.equal(timers.size, 1);
    assert.equal(payload.grant.permissions[0], "files.read");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
